# Database Normalization Differences: 1NF → 2NF → 3NF

## Quick Reference Table

| Aspect | TABLES.md (Original) | TABLES-2NF.md | TABLES-3NF.md |
|--------|---------------------|---------------|---------------|
| **1NF Status** | ⚠️ ~85% (JSON violations) | ✅ 100% | ✅ 100% |
| **2NF Status** | ✅ 100% | ✅ 100% | ✅ 100% |
| **3NF Status** | ⚠️ ~90% (calculated fields) | ⚠️ ~90% (calculated fields) | ✅ 100% |
| **JSON Columns** | 4 (facilities, benefits, metadata×2) | 2 (metadata only) | 2 (metadata only) |
| **Triggers** | 0 | 0 | 7 |
| **Production Ready** | ❌ No | ⚠️ Partial | ✅ Yes |

---

## Change 1: Original → 2NF (1NF Compliance)

### ❌ Removed Columns

#### venues Table
```diff
- facilities JSON NULL COMMENT 'Array of facility names',
```
**Reason:** JSON array violates 1NF (non-atomic values)  
**Impact:** Application must use separate facilities table or string concatenation

#### ticket_types Table
```diff
- benefits TEXT NULL COMMENT 'Benefits of this ticket type',
```
**Reason:** TEXT field storing multiple benefits violates 1NF  
**Impact:** Application must manage benefits differently or use separate table

### ✅ Kept Columns (Acceptable Exceptions)

#### payments Table
```sql
metadata JSON NULL COMMENT 'Additional payment gateway metadata',
```
**Justification:** Audit/debugging data, not core business logic

#### notifications Table
```sql
metadata JSON NULL COMMENT 'Additional notification data',
```
**Justification:** Flexible notification payload, not queried

#### audit_trail Table
```sql
old_values JSON NULL COMMENT 'Previous values before change',
new_values JSON NULL COMMENT 'New values after change',
```
**Justification:** Audit requirement for change tracking

### Summary: Original → 2NF
- **Removed:** 2 JSON columns (facilities, benefits)
- **Kept:** 4 JSON columns (audit/metadata only)
- **Status:** 100% 1NF compliant

---

## Change 2: 2NF → 3NF (Eliminate Transitive Dependencies)

### 🔧 Trigger 1 & 2: orders.final_amount

**Problem in 2NF:**
```sql
-- Calculated field stored without enforcement
final_amount DECIMAL(10, 2) NOT NULL COMMENT 'Final amount after all adjustments',
```
**Transitive Dependency:** `final_amount` depends on `total_amount`, `discount_amount`, `tax_amount`, `service_fee`

**3NF Solution:**
```sql
-- Add BEFORE INSERT trigger
DELIMITER //
CREATE TRIGGER orders_calculate_final_amount_insert
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
    SET NEW.final_amount = NEW.total_amount - NEW.discount_amount + NEW.tax_amount + NEW.service_fee;
END//

-- Add BEFORE UPDATE trigger
CREATE TRIGGER orders_calculate_final_amount_update
BEFORE UPDATE ON orders
FOR EACH ROW
BEGIN
    SET NEW.final_amount = NEW.total_amount - NEW.discount_amount + NEW.tax_amount + NEW.service_fee;
END//
DELIMITER ;
```
**Result:** Automatic calculation ensures consistency

---

### 🔧 Trigger 3 & 4: order_items.subtotal

**Problem in 2NF:**
```sql
-- Calculated field stored without enforcement
subtotal DECIMAL(10, 2) NOT NULL COMMENT 'Subtotal for this line item (quantity * unit_price)',
```
**Transitive Dependency:** `subtotal` depends on `quantity` and `unit_price`

**3NF Solution:**
```sql
-- Add BEFORE INSERT trigger
DELIMITER //
CREATE TRIGGER order_items_calculate_subtotal_insert
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
    SET NEW.subtotal = NEW.quantity * NEW.unit_price;
END//

-- Add BEFORE UPDATE trigger
CREATE TRIGGER order_items_calculate_subtotal_update
BEFORE UPDATE ON order_items
FOR EACH ROW
BEGIN
    SET NEW.subtotal = NEW.quantity * NEW.unit_price;
END//
DELIMITER ;
```
**Result:** Automatic calculation ensures consistency

---

### 🔧 Trigger 5, 6, 7: ticket_types.quantity_sold & quantity_reserved

**Problem in 2NF:**
```sql
-- Derived fields stored without enforcement
quantity_sold INT NOT NULL DEFAULT 0 COMMENT 'Number of tickets sold',
quantity_reserved INT NOT NULL DEFAULT 0 COMMENT 'Number of tickets currently reserved',
```
**Transitive Dependency:** These values can be derived by counting tickets with specific statuses

**3NF Solution:**
```sql
-- Trigger 5: Handle sold status
DELIMITER //
CREATE TRIGGER tickets_update_quantities_on_sold
AFTER UPDATE ON tickets
FOR EACH ROW
BEGIN
    IF OLD.status = 'reserved' AND NEW.status = 'sold' THEN
        UPDATE ticket_types 
        SET quantity_reserved = quantity_reserved - 1,
            quantity_sold = quantity_sold + 1,
            quantity_available = quantity_available
        WHERE ticket_type_id = NEW.ticket_type_id;
    END IF;
    
    IF OLD.status = 'available' AND NEW.status = 'sold' THEN
        UPDATE ticket_types 
        SET quantity_available = quantity_available - 1,
            quantity_sold = quantity_sold + 1
        WHERE ticket_type_id = NEW.ticket_type_id;
    END IF;
END//

-- Trigger 6: Handle reserved status
CREATE TRIGGER tickets_update_quantities_on_reserved
AFTER UPDATE ON tickets
FOR EACH ROW
BEGIN
    IF OLD.status = 'available' AND NEW.status = 'reserved' THEN
        UPDATE ticket_types 
        SET quantity_available = quantity_available - 1,
            quantity_reserved = quantity_reserved + 1
        WHERE ticket_type_id = NEW.ticket_type_id;
    END IF;
END//

-- Trigger 7: Handle cancellations and refunds
CREATE TRIGGER tickets_update_quantities_on_cancel_refund
AFTER UPDATE ON tickets
FOR EACH ROW
BEGIN
    IF OLD.status IN ('sold', 'reserved') AND NEW.status IN ('cancelled', 'refunded') THEN
        IF OLD.status = 'sold' THEN
            UPDATE ticket_types 
            SET quantity_sold = quantity_sold - 1,
                quantity_available = quantity_available + 1
            WHERE ticket_type_id = NEW.ticket_type_id;
        ELSEIF OLD.status = 'reserved' THEN
            UPDATE ticket_types 
            SET quantity_reserved = quantity_reserved - 1,
                quantity_available = quantity_available + 1
            WHERE ticket_type_id = NEW.ticket_type_id;
        END IF;
    END IF;
END//
DELIMITER ;
```
**Result:** Quantities auto-update when ticket status changes

---

## Summary of All Changes

### 🔴 Original → 2NF (1NF Compliance)
| Change Type | Column | Action | Reason |
|-------------|--------|--------|--------|
| **Removal** | `venues.facilities` | ❌ Deleted | JSON array (non-atomic) |
| **Removal** | `ticket_types.benefits` | ❌ Deleted | Multi-value text |
| **Kept** | `payments.metadata` | ✅ Retained | Audit data |
| **Kept** | `notifications.metadata` | ✅ Retained | Flexible payload |
| **Kept** | `audit_trail.old_values` | ✅ Retained | Change tracking |
| **Kept** | `audit_trail.new_values` | ✅ Retained | Change tracking |

### 🟢 2NF → 3NF (Eliminate Dependencies)
| Change Type | Feature | Action | Implementation |
|-------------|---------|--------|----------------|
| **Enforcement** | `orders.final_amount` | 🔧 Add triggers | 2 triggers (INSERT/UPDATE) |
| **Enforcement** | `order_items.subtotal` | 🔧 Add triggers | 2 triggers (INSERT/UPDATE) |
| **Enforcement** | `ticket_types.quantity_sold` | 🔧 Add triggers | 3 triggers (status changes) |
| **Enforcement** | `ticket_types.quantity_reserved` | 🔧 Add triggers | 3 triggers (status changes) |
| **Automation** | Inventory logging | 🔧 Add trigger | 1 trigger (audit trail) |

---

## Visual Comparison

### Column Count Changes
```
Original (TABLES.md):        venues: 15 cols,  ticket_types: 16 cols
2NF (TABLES-2NF.md):        venues: 14 cols,  ticket_types: 15 cols  (-2 JSON cols)
3NF (TABLES-3NF.md):        venues: 14 cols,  ticket_types: 15 cols  (+7 triggers)
```

### Trigger Distribution
```
TABLES.md:      0 triggers
TABLES-2NF.md:  0 triggers
TABLES-3NF.md:  7 triggers
                ├── 2 triggers for orders.final_amount
                ├── 2 triggers for order_items.subtotal
                ├── 3 triggers for ticket_types quantities
                └── 1 trigger for inventory logging
```

---

## Intentional Denormalization (Remains in All Versions)

### tickets.price_paid
```sql
price_paid DECIMAL(10, 2) NOT NULL COMMENT 'Price paid for this ticket (historical)',
```
**Why it stays:** Business requirement - need historical price for refunds  
**Enforcement:** Application-level (set once, immutable)  
**Status:** ✅ Acceptable in 1NF, 2NF, and 3NF

---

## Migration Path

### Step 1: Apply 2NF Changes
```sql
-- Remove JSON columns
ALTER TABLE venues DROP COLUMN facilities;
ALTER TABLE ticket_types DROP COLUMN benefits;
```

### Step 2: Apply 3NF Changes
```sql
-- Add all 7 triggers (see TABLES-3NF.md section 9)
-- No schema changes needed - only trigger additions
```

### Step 3: Verify
```sql
-- Test all triggers (see TABLES-3NF.md section 13)
-- Verify calculated fields auto-update
-- Check inventory logs are auto-created
```

---

## Quick Decision Guide

**Use TABLES.md if:**
- ❌ Not recommended for production
- ⚠️ Useful for prototyping only

**Use TABLES-2NF.md if:**
- ✅ Need simple schema without triggers
- ✅ Will calculate values in application layer
- ⚠️ Accept manual consistency management

**Use TABLES-3NF.md if:**
- ✅ Production environment
- ✅ Need automatic consistency enforcement
- ✅ Want complete audit trails
- ✅ Prefer database-level integrity
- ✅ **RECOMMENDED** ⭐

---

## Key Takeaways

1. **1NF → 2NF:** Remove JSON columns (structure change)
2. **2NF → 3NF:** Add triggers (behavior change, no structure change)
3. **All versions:** Keep intentional denormalization (tickets.price_paid)
4. **Production:** Use 3NF with triggers for automatic consistency

---

## Files Reference

- **TABLES.md** - Original schema with JSON
- **TABLES-2NF.md** - JSON removed, no triggers
- **TABLES-3NF.md** - JSON removed + 7 triggers (PRODUCTION READY)
- **ERD-TABLES.md** - Visual diagram of original
- **ERD-TABLES-2NF.md** - Visual diagram of 2NF
- **ERD-TABLES-3NF.md** - Visual diagram of 3NF with triggers

# Database Schema Versions

## Available Schemas

OneStage has multiple database schema versions to support different use cases:

| Schema | File | Status | Use Case |
|--------|------|--------|----------|
| **Original** | [database/TABLES.md](database/TABLES.md) | ✅ Stable | Integer PKs with AUTO_INCREMENT |
| **UUID** | [database/TABLES-UUID.md](database/TABLES-UUID.md) | ✅ **Recommended** | UUID PKs for distributed systems |
| **2NF** | [TABLES-2NF.md](TABLES-2NF.md) | ✅ Stable | 2nd Normal Form (no JSON columns) |
| **3NF** | [TABLES-3NF.md](TABLES-3NF.md) | ✅ Stable | 3rd Normal Form with triggers |

---

## 🎯 Recommended: UUID Schema

The **UUID-based schema** ([TABLES-UUID.md](database/TABLES-UUID.md)) is now the **default and recommended** approach for OneStage:

### ✅ Why UUID?

1. **Distributed Systems** - Generate IDs independently across services
2. **Security** - Cannot enumerate or predict IDs
3. **Microservices Ready** - No coordination needed for ID generation
4. **API Security** - Safer in public-facing endpoints
5. **Merge Friendly** - Offline ID generation for mobile/sync scenarios
6. **Privacy** - Harder to infer database size or creation order

### 📊 Schema Comparison

| Feature | Integer (BIGINT) | UUID (VARCHAR 36) |
|---------|------------------|-------------------|
| Storage Size | 8 bytes | 36 bytes |
| Index Performance | ⚡ Faster (sequential) | 🔸 Slower (random) |
| Security | ⚠️ Enumerable | ✅ Secure |
| Distributed Gen | ❌ Requires coordination | ✅ Independent |
| Human Readable | ✅ Easy (1, 2, 3) | ⚠️ Hard (UUID strings) |
| Collision Risk | ⚠️ Per-database | ✅ Globally unique |
| API Exposure | ⚠️ Leaks info | ✅ Safe |

---

## 🚀 Getting Started

### For New Projects: Use UUID Schema

```bash
# 1. Create tables from UUID schema
mysql -u root -p onestage < database/TABLES-UUID.sql  # (Create this from .md)

# 2. Initialize admin user (already uses UUID!)
cd infrastructure/sql
npm install
npm run generate-password
# Update 01-init-admin-user.sql with hash
mysql -u root -p onestage < 01-init-admin-user.sql
```

### For Existing Projects: Migration Path

If you have an existing database with integer IDs, see the [Migration Guide](database/TABLES-UUID.md#migration-path) in the UUID schema documentation.

---

## 📋 Schema Details

### 1. Original Schema (Integer PKs)
- **File:** [database/TABLES.md](database/TABLES.md)
- **Primary Keys:** `BIGINT UNSIGNED AUTO_INCREMENT`
- **Status:** Stable, but not recommended for new projects
- **Use Case:** Legacy compatibility, single-instance deployments

### 2. UUID Schema (Recommended)
- **File:** [database/TABLES-UUID.md](database/TABLES-UUID.md)
- **Primary Keys:** `VARCHAR(36) DEFAULT (UUID())`
- **Status:** ✅ **Recommended for all new projects**
- **Use Case:** Production deployments, microservices, distributed systems, public APIs

### 3. 2NF Schema
- **File:** [TABLES-2NF.md](TABLES-2NF.md)
- **Focus:** Removed JSON columns (venues.facilities, ticket_types.benefits)
- **Normalization:** 100% 1NF, 100% 2NF, ~90% 3NF
- **Use Case:** Academic study, normalization analysis

### 4. 3NF Schema with Triggers
- **File:** [TABLES-3NF.md](TABLES-3NF.md)
- **Focus:** Full 3rd Normal Form with 8 MySQL triggers
- **Normalization:** 100% 1NF, 100% 2NF, 100% 3NF
- **Use Case:** Strict normalization requirements, audit trail enforcement

---

## 🔄 Combining Schemas

You can **combine** normalization levels with UUID:

### UUID + 3NF (Recommended for Production)
- Use UUID primary keys from [TABLES-UUID.md](database/TABLES-UUID.md)
- Apply triggers from [TABLES-3NF.md](TABLES-3NF.md) for calculated fields
- **Result:** Secure, normalized, production-ready schema

### Example:
```sql
-- From TABLES-UUID.md
CREATE TABLE orders (
    order_id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
    -- ... other columns
);

-- Add trigger from TABLES-3NF.md
DELIMITER $$
CREATE TRIGGER orders_calculate_final_amount_insert
BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
    SET NEW.final_amount = NEW.total_amount - NEW.discount_amount + NEW.tax_amount + NEW.service_fee;
END$$
DELIMITER ;
```

---

## 📊 Current Init Scripts Compatibility

| Script | Compatible With |
|--------|-----------------|
| `01-init-admin-user.sql` | ✅ UUID Schema |
| `01-init-admin-user.sql` | ⚠️ Integer Schema (needs modification) |

The admin initialization script **already uses UUID** via `SET @admin_uuid = UUID()`, so it's **ready for the UUID schema**.

---

## 🛠️ Tools & Scripts

### Generate SQL from Markdown
The `.md` schema files are documentation. To create executable SQL:

```bash
# Extract CREATE TABLE statements from markdown
grep -A 50 "CREATE TABLE" database/TABLES-UUID.md > database/TABLES-UUID.sql
```

Or use the provided conversion script:
```bash
node tools/convert-schema-to-sql.js database/TABLES-UUID.md > infrastructure/sql/02-create-all-tables-uuid.sql
```

### Admin User Initialization
```bash
cd infrastructure/sql
npm install
npm run generate-password  # Generate bcrypt hash
# Update 01-init-admin-user.sql
mysql -u root -p onestage < 01-init-admin-user.sql
```

---

## 🔐 Security Considerations

### UUID Schema (Recommended)
- ✅ IDs cannot be enumerated
- ✅ Cannot guess valid IDs
- ✅ Safe in URL parameters
- ✅ Safe in public APIs
- ⚠️ Still validate access control!

### Integer Schema
- ⚠️ Predictable IDs (1, 2, 3, ...)
- ⚠️ Can enumerate all records
- ⚠️ Can infer database size
- ⚠️ Can guess valid IDs
- ❌ Not recommended for public APIs

---

## 📚 Documentation

- **Schema Files:** [database/](database/)
- **Init Scripts:** [infrastructure/sql/](infrastructure/sql/)
- **ERD Diagrams:** [ERD-TABLES*.md](ERD-TABLES.md)
- **Normalization Comparison:** [NORMALIZATION-DIFFERENCES.md](NORMALIZATION-DIFFERENCES.md)

---

## ❓ Decision Guide

**Choose UUID Schema if:**
- ✅ Building microservices
- ✅ Multi-region deployment
- ✅ Public-facing APIs
- ✅ Security is critical
- ✅ Need offline ID generation
- ✅ Planning to scale horizontally

**Choose Integer Schema if:**
- ✅ Single-instance deployment
- ✅ Internal-only application
- ✅ Maximum query performance critical
- ✅ Minimal storage requirements
- ✅ Simple debugging needs

**For most projects: Choose UUID! 🎯**

---

**Last Updated:** 2026-08-25  
**Recommended Schema:** [UUID](database/TABLES-UUID.md)  
**Status:** Production Ready ✅

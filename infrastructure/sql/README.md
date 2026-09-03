# Database Migration Scripts

This folder contains SQL scripts and tools to manage the OneStage database schema on AWS RDS MySQL.

## Files

- **`01-drop-all-tables.sql`** - Drops all existing tables (handles foreign keys correctly)
- **`02-create-all-tables.sql`** - Creates all 19 tables from the schema
- **`../migrate-database.ps1`** - PowerShell script to run the migration

## Prerequisites

1. **MySQL Client** installed on your system
   ```powershell
   # Check if installed
   mysql --version
   
   # Install via winget (Windows)
   winget install Oracle.MySQL
   
   # Or via Chocolatey
   choco install mysql
   ```

2. **Environment Variables** configured in `.env` file at repository root
   ```env
   DB_HOST=your-rds-instance.region.rds.amazonaws.com
   DB_PORT=3306
   DB_NAME=onestagedb
   DB_USER=your_username
   DB_PASSWORD=your_password
   DB_SSL=true
   ```

## Usage

### Option 1: Run PowerShell Migration Script (Recommended)

From the repository root:

```powershell
# Run the migration script
.\infrastructure\migrate-database.ps1
```

This script will:
1. Load your RDS credentials from `.env`
2. Ask for confirmation before proceeding
3. Drop all existing tables
4. Create all 19 tables from the schema
5. Verify the migration was successful

### Option 2: Run SQL Scripts Manually

If you prefer to run the SQL scripts directly:

```powershell
# Set your database credentials
$DB_HOST = "your-rds-instance.region.rds.amazonaws.com"
$DB_USER = "your_username"
$DB_PASSWORD = "your_password"
$DB_NAME = "onestagedb"

# Drop all tables
Get-Content infrastructure\sql\01-drop-all-tables.sql | mysql -h $DB_HOST -u $DB_USER -p$DB_PASSWORD $DB_NAME --ssl-mode=REQUIRED

# Create all tables
Get-Content infrastructure\sql\02-create-all-tables.sql | mysql -h $DB_HOST -u $DB_USER -p$DB_PASSWORD $DB_NAME --ssl-mode=REQUIRED
```

### Option 3: Use MySQL Workbench or GUI Tool

1. Connect to your RDS instance using MySQL Workbench
2. Open and execute `01-drop-all-tables.sql`
3. Open and execute `02-create-all-tables.sql`

## Database Schema Summary

The schema creates **19 tables**:

### Core Tables (11)
- `customers` - Customer accounts
- `venues` - Event venues
- `events` - Event information
- `ticket_types` - Ticket categories
- `tickets` - Individual tickets
- `orders` - Customer orders
- `order_items` - Order line items
- `payments` - Payment transactions
- `waiting_queues` - Virtual queue system
- `notifications` - User notifications
- `event_reviews` - Event ratings and reviews

### History/Audit Tables (8)
- `customer_login_history` - Login tracking
- `customer_password_history` - Password changes
- `event_history` - Event modifications
- `ticket_check_in_history` - Check-in audit
- `inventory_logs` - Inventory changes
- `order_history` - Order status changes
- `queue_history` - Queue movements
- `audit_trail` - General audit log

## Verification

After running the migration, verify your tables:

```sql
-- Connect to your database
mysql -h your-rds-instance.region.rds.amazonaws.com -u your_username -p onestagedb --ssl-mode=REQUIRED

-- List all tables
SHOW TABLES;

-- Verify table structure
DESCRIBE customers;
DESCRIBE events;
DESCRIBE orders;
```

## Safety Features

- **Foreign key checks** are temporarily disabled during drops to handle dependencies
- **Confirmation prompt** before dropping tables (in PowerShell script)
- **Transaction safety** - Each CREATE TABLE is atomic
- **Validation queries** at the end to confirm success

## Troubleshooting

### MySQL client not found
```powershell
# Install MySQL client
winget install Oracle.MySQL
# Or
choco install mysql
```

### Connection timeout
- Check your RDS security group allows your IP address
- Verify RDS instance is publicly accessible (if connecting from outside VPC)
- Check VPC/subnet settings

### Permission denied
- Ensure your database user has CREATE and DROP privileges
- For RDS master user: `GRANT ALL PRIVILEGES ON onestagedb.* TO 'your_user'@'%';`

### SSL connection issues
- Use `--ssl-mode=REQUIRED` for RDS connections
- Set `DB_SSL=true` in your `.env` file

## Schema Documentation

For detailed schema documentation, see:
- **[TABLES.md](../../TABLES.md)** - Complete table definitions with SQL
- **[ERD.md](../../ERD.md)** - Entity Relationship Diagram

## Next Steps

After successful migration:
1. ✅ Add seed data for testing
2. ✅ Configure your Node.js services to connect to RDS
3. ✅ Set up connection pooling
4. ✅ Implement database backup strategy
5. ✅ Test CRUD operations from your services

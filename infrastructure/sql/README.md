# Database Management Scripts

This folder contains SQL scripts and tools to manage the OneStage database schema and initialization on AWS RDS MySQL.

## 📁 Files Overview

### Schema Management
- **`02-create-all-tables.sql`** - Creates all 19 tables from the schema
- **`../migrate-database.ps1`** - PowerShell script to run the migration

**📌 Note:** The init scripts now use **UUID for all primary keys** per the [UUID schema](../../database/TABLES-UUID.md).

### Admin Initialization (New!)
- **`01-init-admin-user.sql.example`** - Template for admin initialization (commit this!)
- **`01-init-admin-user.sql`** - Actual credentials (gitignored, do NOT commit!)
- **`generate-admin-password.js`** - Generate bcrypt hash for admin password
- **`test-password-verification.js`** - Verify password hash works correctly
- **`package.json`** - NPM dependencies for password utilities
- **`QUICK-START.md`** - Quick reference guide (⚡ START HERE!)
- **`INIT-ADMIN-README.md`** - Detailed admin initialization documentation

## 🔒 Security Notice
**IMPORTANT:** Files with actual credentials (`*-init-*.sql`) are automatically excluded from git!  
Always use the `.example` templates and copy them locally with your real credentials.

## 🚀 Quick Start

### First Time Setup
```bash
# 1. Create database schema
mysql -u root -p onestage < infrastructure/sql/02-create-all-tables.sql

# 2. Initialize admin user (see QUICK-START.md for details)
cd infrastructure/sql
npm install
npm run generate-password  # Copy the hash
# Update 01-init-admin-user.sql with the hash
mysql -u root -p onestage < 01-init-admin-user.sql
```

📖 **Need help?** See [QUICK-START.md](QUICK-START.md) for step-by-step instructions.

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
$DB_NAME = "onestage"

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

The schema creates **18 tables**:

### Core Tables (11)
- `users` - User accounts
- `venues` - Event venues
- `events` - Event information
- `ticket_types` - Ticket categories
- `tickets` - Individual tickets
- `orders` - User orders
- `order_items` - Order line items
- `payments` - Payment transactions
- `waiting_queues` - Virtual queue system
- `notifications` - User notifications
- `event_reviews` - Event ratings and reviews

### History/Audit Tables (7)
- `user_login_history` - Login tracking
- `event_history` - Event modifications
- `users_events` - Per-event admin/helper role assignments
- `ticket_check_in_history` - Check-in audit
- `order_history` - Order status changes
- `queue_history` - Queue movements
- `audit_trail` - General audit log

## Verification

After running the migration, verify your tables:

```sql
-- Connect to your database
mysql -h your-rds-instance.region.rds.amazonaws.com -u your_username -p onestage --ssl-mode=REQUIRED

-- List all tables
SHOW TABLES;

-- Verify table structure
DESCRIBE users;
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
- For RDS master user: `GRANT ALL PRIVILEGES ON onestage.* TO 'your_user'@'%';`

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

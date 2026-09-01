# Quick Start Guide - Admin User Initialization

## � Security Notice
**The actual credential file `01-init-admin-user.sql` is gitignored for security!**  
Use the template: `01-init-admin-user.sql.example`

---

## 🚀 Fast Setup (4 Steps)

### 0️⃣ Create Your Credential File
```bash
cd infrastructure/sql
cp 01-init-admin-user.sql.example 01-init-admin-user.sql
# Edit 01-init-admin-user.sql with your actual email and admin details
```

### 1️⃣ Install Dependencies
```bash
npm install
```

### 2️⃣ Generate Password Hash
```bash
npm run generate-password
```
Copy the generated hash and update `01-init-admin-user.sql` line 36:
```sql
password_hash = '[PASTE-YOUR-HASH-HERE]'
```

### 3️⃣ Run SQL Script
```bash
mysql -u root -p onestage < 01-init-admin-user.sql
```

 

**⚠️ CHANGE PASSWORD AFTER FIRST LOGIN!**

---

## ✅ Verify Installation

```sql
SELECT customer_name, email, admin_ind, status 
FROM customers 
WHERE customer_name = 'ADMIN';
```

Expected output:
```
customer_name | email                     | admin_ind | status
ADMIN         | rubyferdianto@u.nus.edu   | Y         | active
```

---

## 🧪 Test Password (Optional)

```bash
npm run test-password
```

---

## 📁 Files Created

- ✅ `01-init-admin-user.sql` - Main initialization script
- ✅ `generate-admin-password.js` - Password hash generator
- ✅ `test-password-verification.js` - Verification test
- ✅ `package.json` - NPM dependencies
- ✅ `INIT-ADMIN-README.md` - Detailed documentation
- ✅ `QUICK-START.md` - This file

---

## 🛠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| bcrypt not found | Run `npm install` in `infrastructure/sql/` |
| Database not found | Create database: `CREATE DATABASE onestage;` |
| Table doesn't exist | Run `02-create-all-tables.sql` first |
| Duplicate email | User already exists, use different email |

---

## 📞 Need Help?

See detailed documentation: [INIT-ADMIN-README.md](INIT-ADMIN-README.md)

---

**Last Updated:** 2026-08-25

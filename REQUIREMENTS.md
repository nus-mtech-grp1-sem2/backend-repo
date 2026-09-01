# Requirements & Setup

This document outlines the prerequisites and setup steps required to run the OneStage backend services.

## Prerequisites

### 1. Node.js & npm
- **Node.js**: v18.x or higher
- **npm**: v9.x or higher

Check your versions:
```bash
node --version
npm --version
```

### 2. AWS RDS MySQL Database
- MySQL version 8.x
- RDS instance must be accessible from your network
- Security group configured to allow inbound connections on port 3306

## Required npm Packages

Install the following packages before running the services:

### Core Dependencies
```bash
npm install dotenv mysql2
```

- **dotenv** (^16.x): Load environment variables from .env file
- **mysql2** (^3.x): MySQL client with promise support

### Install All Dependencies
To install all project dependencies at once:
```bash
npm install
```

## Environment Configuration

### 1. Copy Environment Template
```bash
cp .env.example .env
```

### 2. Configure Database Credentials
Edit the `.env` file with your RDS MySQL connection details:

```env
DB_HOST=your-rds-instance.region.rds.amazonaws.com
DB_PORT=3306
DB_NAME=onestage
DB_USER=your_username
DB_PASSWORD=your_password
DB_SSL=true
```

**Required Variables:**
- `DB_HOST`: RDS endpoint (found in AWS RDS Console)
- `DB_PORT`: MySQL port (default: 3306)
- `DB_NAME`: Database name
- `DB_USER`: Database username
- `DB_PASSWORD`: Database password
- `DB_SSL`: Enable SSL connection (recommended for RDS)

**Optional Variables:**
- `DB_CONNECTION_LIMIT`: Connection pool limit (default: 10)
- `DB_CONNECT_TIMEOUT`: Connection timeout in ms (default: 10000)
- `DB_TIMEZONE`: Database timezone (default: UTC)
- `DB_CHARSET`: Character set (default: utf8mb4)

### 3. Database Creation
The database `onestage` should already be created on your RDS instance.

## Security Checklist

- ✅ `.env` file is in `.gitignore` (never commit credentials)
- ✅ RDS security group restricts access to known IPs only
- ✅ Use strong passwords for database users
- ✅ Enable SSL/TLS for database connections
- ✅ Rotate credentials regularly

## Verification

Test your database connection:
```javascript
require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false }
    });
    console.log('✅ Database connected successfully!');
    await connection.end();
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  }
}

testConnection();
```

## Troubleshooting

### Connection Timeout
- Check RDS security group inbound rules
- Verify your IP address is whitelisted
- Ensure RDS instance is publicly accessible (if connecting from outside VPC)

### Authentication Failed
- Verify username and password in `.env`


### SSL/TLS Issues
- Set `DB_SSL=false` temporarily to test without SSL
- Ensure your RDS instance has SSL certificates configured

## Next Steps

Once requirements are met:
1. Install dependencies: `npm install`
2. Configure `.env` file
3. Verify database connection
4. Run database migrations (when available)
5. Start individual services or use docker-compose

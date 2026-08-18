require('dotenv').config();
const mysql = require('mysql2/promise');

const tables = [
  {
    name: 'users',
    sql: `CREATE TABLE users (
      user_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      admin_ind VARCHAR(1) NOT NULL DEFAULT 'N',
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      phone_number VARCHAR(20),
      date_of_birth DATE,
      status ENUM('active', 'suspended', 'deleted') DEFAULT 'active',
      email_verified BOOLEAN DEFAULT FALSE,
      phone_verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL,
      
      INDEX idx_email (email),
      INDEX idx_username (username),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'user_login_history',
    sql: `CREATE TABLE user_login_history (
      login_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(45),
      user_agent TEXT,
      device_type VARCHAR(50),
      login_status ENUM('success', 'failed', 'blocked') DEFAULT 'success',
      failure_reason VARCHAR(255),
      session_id VARCHAR(255),
      logout_time TIMESTAMP NULL,
      
      INDEX idx_user_id (user_id),
      INDEX idx_login_time (login_time),
      INDEX idx_login_status (login_status),
      INDEX idx_session_id (session_id),
      
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'user_password_history',
    sql: `CREATE TABLE user_password_history (
      history_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      old_password_hash VARCHAR(255) NOT NULL,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      changed_by_user_id BIGINT UNSIGNED,
      ip_address VARCHAR(45),
      reason VARCHAR(255),
      
      INDEX idx_user_id (user_id),
      INDEX idx_changed_at (changed_at),
      
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'venues',
    sql: `CREATE TABLE venues (
      venue_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      venue_name VARCHAR(255) NOT NULL,
      address VARCHAR(500),
      city VARCHAR(100),
      state VARCHAR(100),
      country VARCHAR(100),
      postal_code VARCHAR(20),
      capacity INT UNSIGNED,
      venue_type ENUM('indoor', 'outdoor', 'virtual', 'hybrid') DEFAULT 'indoor',
      facilities JSON,
      contact_email VARCHAR(255),
      contact_phone VARCHAR(20),
      latitude DECIMAL(10, 8),
      longitude DECIMAL(11, 8),
      status ENUM('active', 'inactive', 'maintenance') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_city (city),
      INDEX idx_country (country),
      INDEX idx_status (status),
      INDEX idx_coordinates (latitude, longitude)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'events',
    sql: `CREATE TABLE events (
      event_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event_name VARCHAR(255) NOT NULL,
      event_description TEXT,
      event_type ENUM('concert', 'sports', 'theater', 'conference', 'festival', 'other') NOT NULL,
      venue_id BIGINT UNSIGNED,
      organizer_id BIGINT UNSIGNED NOT NULL,
      event_start_datetime TIMESTAMP NOT NULL,
      event_end_datetime TIMESTAMP NOT NULL,
      doors_open_time TIMESTAMP,
      age_restriction VARCHAR(20),
      dress_code VARCHAR(100),
      status ENUM('draft', 'published', 'cancelled', 'postponed', 'completed') DEFAULT 'draft',
      cancellation_reason TEXT,
      total_capacity INT UNSIGNED,
      featured BOOLEAN DEFAULT FALSE,
      banner_image_url VARCHAR(500),
      thumbnail_image_url VARCHAR(500),
      terms_conditions TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      published_at TIMESTAMP NULL,
      
      INDEX idx_event_name (event_name),
      INDEX idx_event_type (event_type),
      INDEX idx_venue_id (venue_id),
      INDEX idx_organizer_id (organizer_id),
      INDEX idx_start_datetime (event_start_datetime),
      INDEX idx_status (status),
      INDEX idx_featured (featured),
      
      FOREIGN KEY (venue_id) REFERENCES venues(venue_id) ON DELETE SET NULL,
      FOREIGN KEY (organizer_id) REFERENCES users(user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'event_history',
    sql: `CREATE TABLE event_history (
      history_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event_id BIGINT UNSIGNED NOT NULL,
      changed_by_user_id BIGINT UNSIGNED NOT NULL,
      change_type ENUM('created', 'updated', 'published', 'cancelled', 'postponed') NOT NULL,
      field_changed VARCHAR(100),
      old_value TEXT,
      new_value TEXT,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(45),
      notes TEXT,
      
      INDEX idx_event_id (event_id),
      INDEX idx_changed_by (changed_by_user_id),
      INDEX idx_changed_at (changed_at),
      INDEX idx_change_type (change_type),
      
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'ticket_types',
    sql: `CREATE TABLE ticket_types (
      ticket_type_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event_id BIGINT UNSIGNED NOT NULL,
      type_name VARCHAR(100) NOT NULL,
      type_description TEXT,
      price DECIMAL(10, 2) NOT NULL,
      quantity_total INT UNSIGNED NOT NULL,
      quantity_available INT UNSIGNED NOT NULL,
      quantity_sold INT UNSIGNED DEFAULT 0,
      quantity_reserved INT UNSIGNED DEFAULT 0,
      max_per_order INT UNSIGNED DEFAULT 10,
      sale_start_datetime TIMESTAMP NOT NULL,
      sale_end_datetime TIMESTAMP NOT NULL,
      status ENUM('active', 'sold_out', 'inactive') DEFAULT 'active',
      seating_section VARCHAR(50),
      benefits JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_event_id (event_id),
      INDEX idx_status (status),
      INDEX idx_sale_dates (sale_start_datetime, sale_end_datetime),
      INDEX idx_price (price),
      
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'tickets',
    sql: `CREATE TABLE tickets (
      ticket_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ticket_uuid VARCHAR(36) UNIQUE NOT NULL,
      event_id BIGINT UNSIGNED NOT NULL,
      ticket_type_id BIGINT UNSIGNED NOT NULL,
      order_id BIGINT UNSIGNED,
      user_id BIGINT UNSIGNED,
      ticket_code VARCHAR(100) UNIQUE NOT NULL,
      qr_code_url VARCHAR(500),
      seat_number VARCHAR(50),
      status ENUM('available', 'reserved', 'sold', 'used', 'cancelled', 'refunded') DEFAULT 'available',
      price_paid DECIMAL(10, 2),
      issued_at TIMESTAMP NULL,
      used_at TIMESTAMP NULL,
      checked_in_at TIMESTAMP NULL,
      checked_in_by_user_id BIGINT UNSIGNED,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_ticket_uuid (ticket_uuid),
      INDEX idx_ticket_code (ticket_code),
      INDEX idx_event_id (event_id),
      INDEX idx_ticket_type_id (ticket_type_id),
      INDEX idx_order_id (order_id),
      INDEX idx_user_id (user_id),
      INDEX idx_status (status),
      
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(ticket_type_id) ON DELETE RESTRICT,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'orders',
    sql: `CREATE TABLE orders (
      order_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      order_number VARCHAR(50) UNIQUE NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      event_id BIGINT UNSIGNED NOT NULL,
      order_status ENUM('pending', 'confirmed', 'processing', 'completed', 'cancelled', 'refunded') DEFAULT 'pending',
      payment_status ENUM('pending', 'paid', 'failed', 'refunded', 'partial_refund') DEFAULT 'pending',
      total_amount DECIMAL(10, 2) NOT NULL,
      discount_amount DECIMAL(10, 2) DEFAULT 0.00,
      tax_amount DECIMAL(10, 2) DEFAULT 0.00,
      service_fee DECIMAL(10, 2) DEFAULT 0.00,
      final_amount DECIMAL(10, 2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      promo_code VARCHAR(50),
      payment_method VARCHAR(50),
      billing_email VARCHAR(255),
      billing_phone VARCHAR(20),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      confirmed_at TIMESTAMP NULL,
      completed_at TIMESTAMP NULL,
      
      INDEX idx_order_number (order_number),
      INDEX idx_user_id (user_id),
      INDEX idx_event_id (event_id),
      INDEX idx_order_status (order_status),
      INDEX idx_payment_status (payment_status),
      INDEX idx_created_at (created_at),
      
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'ticket_check_in_history',
    sql: `CREATE TABLE ticket_check_in_history (
      check_in_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ticket_id BIGINT UNSIGNED NOT NULL,
      event_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED,
      checked_in_by_user_id BIGINT UNSIGNED NOT NULL,
      check_in_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      check_in_method ENUM('qr_scan', 'manual', 'nfc', 'barcode') NOT NULL,
      device_info TEXT,
      location_gate VARCHAR(50),
      ip_address VARCHAR(45),
      status ENUM('success', 'failed', 'duplicate', 'invalid') DEFAULT 'success',
      failure_reason VARCHAR(255),
      
      INDEX idx_ticket_id (ticket_id),
      INDEX idx_event_id (event_id),
      INDEX idx_user_id (user_id),
      INDEX idx_check_in_time (check_in_time),
      INDEX idx_status (status),
      
      FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
      FOREIGN KEY (checked_in_by_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'inventory_logs',
    sql: `CREATE TABLE inventory_logs (
      log_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ticket_type_id BIGINT UNSIGNED NOT NULL,
      change_type ENUM('created', 'reserved', 'released', 'sold', 'refunded', 'adjusted') NOT NULL,
      quantity_change INT NOT NULL,
      quantity_before INT UNSIGNED NOT NULL,
      quantity_after INT UNSIGNED NOT NULL,
      reference_id BIGINT UNSIGNED,
      reference_type VARCHAR(50),
      changed_by_user_id BIGINT UNSIGNED,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      
      INDEX idx_ticket_type_id (ticket_type_id),
      INDEX idx_change_type (change_type),
      INDEX idx_changed_at (changed_at),
      INDEX idx_reference (reference_type, reference_id),
      
      FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(ticket_type_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'order_items',
    sql: `CREATE TABLE order_items (
      order_item_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT UNSIGNED NOT NULL,
      ticket_type_id BIGINT UNSIGNED NOT NULL,
      ticket_id BIGINT UNSIGNED,
      quantity INT UNSIGNED NOT NULL,
      unit_price DECIMAL(10, 2) NOT NULL,
      subtotal DECIMAL(10, 2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_order_id (order_id),
      INDEX idx_ticket_type_id (ticket_type_id),
      INDEX idx_ticket_id (ticket_id),
      
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_type_id) REFERENCES ticket_types(ticket_type_id) ON DELETE RESTRICT,
      FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'order_history',
    sql: `CREATE TABLE order_history (
      history_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT UNSIGNED NOT NULL,
      status_from VARCHAR(50),
      status_to VARCHAR(50) NOT NULL,
      changed_by_user_id BIGINT UNSIGNED,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reason TEXT,
      notes TEXT,
      ip_address VARCHAR(45),
      
      INDEX idx_order_id (order_id),
      INDEX idx_changed_at (changed_at),
      INDEX idx_status_to (status_to),
      
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'payments',
    sql: `CREATE TABLE payments (
      payment_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT UNSIGNED NOT NULL,
      payment_method VARCHAR(50) NOT NULL,
      payment_provider VARCHAR(100),
      transaction_id VARCHAR(255),
      amount DECIMAL(10, 2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'USD',
      status ENUM('pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled') DEFAULT 'pending',
      payment_date TIMESTAMP NULL,
      refund_date TIMESTAMP NULL,
      refund_amount DECIMAL(10, 2),
      failure_reason TEXT,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_order_id (order_id),
      INDEX idx_transaction_id (transaction_id),
      INDEX idx_status (status),
      INDEX idx_payment_date (payment_date),
      
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'waiting_queues',
    sql: `CREATE TABLE waiting_queues (
      queue_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      queue_token VARCHAR(255) UNIQUE NOT NULL,
      position INT UNSIGNED,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      estimated_wait_time INT UNSIGNED,
      notified_at TIMESTAMP NULL,
      expires_at TIMESTAMP NOT NULL,
      status ENUM('waiting', 'active', 'expired', 'completed', 'cancelled') DEFAULT 'waiting',
      ip_address VARCHAR(45),
      user_agent TEXT,
      
      INDEX idx_event_id (event_id),
      INDEX idx_user_id (user_id),
      INDEX idx_queue_token (queue_token),
      INDEX idx_status (status),
      INDEX idx_position (position),
      INDEX idx_joined_at (joined_at),
      INDEX idx_expires_at (expires_at),
      
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'queue_history',
    sql: `CREATE TABLE queue_history (
      history_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      queue_id BIGINT UNSIGNED NOT NULL,
      event_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      action_type ENUM('joined', 'position_changed', 'activated', 'expired', 'cancelled', 'completed') NOT NULL,
      old_position INT UNSIGNED,
      new_position INT UNSIGNED,
      action_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      
      INDEX idx_queue_id (queue_id),
      INDEX idx_event_id (event_id),
      INDEX idx_user_id (user_id),
      INDEX idx_action_time (action_time),
      INDEX idx_action_type (action_type),
      
      FOREIGN KEY (queue_id) REFERENCES waiting_queues(queue_id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'notifications',
    sql: `CREATE TABLE notifications (
      notification_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      notification_type ENUM('order', 'event', 'queue', 'payment', 'reminder', 'system', 'marketing') NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      related_entity_type VARCHAR(50),
      related_entity_id BIGINT UNSIGNED,
      priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
      status ENUM('pending', 'sent', 'delivered', 'read', 'failed') DEFAULT 'pending',
      channel ENUM('email', 'sms', 'push', 'in_app') NOT NULL,
      sent_at TIMESTAMP NULL,
      read_at TIMESTAMP NULL,
      retry_count INT DEFAULT 0,
      error_message TEXT,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_notification_type (notification_type),
      INDEX idx_status (status),
      INDEX idx_channel (channel),
      INDEX idx_created_at (created_at),
      INDEX idx_related_entity (related_entity_type, related_entity_id),
      
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'notification_preferences',
    sql: `CREATE TABLE notification_preferences (
      preference_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      notification_type VARCHAR(50) NOT NULL,
      email_enabled BOOLEAN DEFAULT TRUE,
      sms_enabled BOOLEAN DEFAULT FALSE,
      push_enabled BOOLEAN DEFAULT TRUE,
      in_app_enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_user_type (user_id, notification_type),
      INDEX idx_user_id (user_id),
      
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'event_reviews',
    sql: `CREATE TABLE event_reviews (
      review_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      event_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      order_id BIGINT UNSIGNED,
      rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
      review_title VARCHAR(255),
      review_text TEXT,
      verified_purchase BOOLEAN DEFAULT FALSE,
      status ENUM('pending', 'approved', 'rejected', 'flagged') DEFAULT 'pending',
      helpful_count INT UNSIGNED DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_event_id (event_id),
      INDEX idx_user_id (user_id),
      INDEX idx_rating (rating),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at),
      
      FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'system_logs',
    sql: `CREATE TABLE system_logs (
      log_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      log_level ENUM('debug', 'info', 'warning', 'error', 'critical') NOT NULL,
      service_name VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      user_id BIGINT UNSIGNED,
      entity_type VARCHAR(50),
      entity_id BIGINT UNSIGNED,
      message TEXT,
      metadata JSON,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_log_level (log_level),
      INDEX idx_service_name (service_name),
      INDEX idx_user_id (user_id),
      INDEX idx_created_at (created_at),
      INDEX idx_entity (entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  },
  {
    name: 'audit_trail',
    sql: `CREATE TABLE audit_trail (
      audit_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      table_name VARCHAR(100) NOT NULL,
      record_id BIGINT UNSIGNED NOT NULL,
      action_type ENUM('INSERT', 'UPDATE', 'DELETE') NOT NULL,
      old_values JSON,
      new_values JSON,
      changed_by_user_id BIGINT UNSIGNED,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(45),
      user_agent TEXT,
      
      INDEX idx_table_record (table_name, record_id),
      INDEX idx_action_type (action_type),
      INDEX idx_changed_by (changed_by_user_id),
      INDEX idx_changed_at (changed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  }
];

async function createTables() {
  console.log('🚀 Starting table creation for OneStage database...\n');
  
  let connection;
  const results = {
    success: [],
    failed: [],
    skipped: []
  };
  
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306'),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      connectTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT || '10000'),
      multipleStatements: true
    });

    console.log('✅ Connected to database:', process.env.DB_NAME);
    console.log('📊 Total tables to create:', tables.length);
    console.log('─'.repeat(60), '\n');

    for (const table of tables) {
      try {
        // Check if table already exists
        const [existing] = await connection.execute(
          `SHOW TABLES LIKE '${table.name}'`
        );

        if (existing.length > 0) {
          console.log(`⚠️  Table '${table.name}' already exists - skipping`);
          results.skipped.push(table.name);
          continue;
        }

        // Create the table
        await connection.execute(table.sql);
        console.log(`✅ Created table: ${table.name}`);
        results.success.push(table.name);

      } catch (error) {
        console.error(`❌ Failed to create table '${table.name}':`, error.message);
        results.failed.push({ name: table.name, error: error.message });
      }
    }

    console.log('\n', '─'.repeat(60));
    console.log('\n📈 Summary:\n');
    console.log(`✅ Successfully created: ${results.success.length} tables`);
    console.log(`⚠️  Skipped (already exist): ${results.skipped.length} tables`);
    console.log(`❌ Failed: ${results.failed.length} tables`);

    if (results.success.length > 0) {
      console.log('\n✅ Created tables:');
      results.success.forEach(name => console.log(`   - ${name}`));
    }

    if (results.skipped.length > 0) {
      console.log('\n⚠️  Skipped tables:');
      results.skipped.forEach(name => console.log(`   - ${name}`));
    }

    if (results.failed.length > 0) {
      console.log('\n❌ Failed tables:');
      results.failed.forEach(item => {
        console.log(`   - ${item.name}: ${item.error}`);
      });
    }

    // Show final table count
    const [allTables] = await connection.execute('SHOW TABLES');
    console.log(`\n📋 Total tables in database: ${allTables.length}`);

    if (results.failed.length > 0) {
      console.log('\n⚠️  Some tables failed to create. Please review the errors above.');
      process.exit(1);
    } else {
      console.log('\n🎉 All tables created successfully!');
    }

  } catch (error) {
    console.error('\n❌ Database connection or operation failed:');
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n🔌 Connection closed.');
    }
  }
}

createTables();

-- Document Tracking System (17 tables). WARNING: this DROPS and recreates every table, so run it only on a fresh setup.
-- Run this whole file in MySQL Workbench 8.0
CREATE DATABASE IF NOT EXISTS dts_db;
USE dts_db;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS audit_logs, notifications, files, tracking_history, releases, approvals, routing,
                     documents, doc_counters, document_types, receivers, senders, employees, statuses,
                     roles, users, departments;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  is_active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','clerk','sender','receiver','approver','office_staff') NOT NULL,
  department_id INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE document_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE
);

-- one row per year; used for duplicate-proof auto-numbering
CREATE TABLE doc_counters (
  year INT PRIMARY KEY,
  last_no INT NOT NULL
);

CREATE TABLE documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  doc_number VARCHAR(20) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  type_id INT NOT NULL,
  origin_dept_id INT NOT NULL,
  created_by INT NOT NULL,
  status ENUM('Registered','Routed','Received','Returned','Approved','Rejected','Released')
         NOT NULL DEFAULT 'Registered',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (type_id) REFERENCES document_types(id),
  FOREIGN KEY (origin_dept_id) REFERENCES departments(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE routing (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  from_dept_id INT NOT NULL,
  to_dept_id INT NOT NULL,
  purpose VARCHAR(200),
  instructions TEXT,
  status ENUM('Pending','Received','Returned') NOT NULL DEFAULT 'Pending',
  routed_by INT NOT NULL,
  routed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  received_by INT NULL,
  received_at DATETIME NULL,
  remarks TEXT,
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (from_dept_id) REFERENCES departments(id),
  FOREIGN KEY (to_dept_id) REFERENCES departments(id),
  FOREIGN KEY (routed_by) REFERENCES users(id),
  FOREIGN KEY (received_by) REFERENCES users(id)
);

CREATE TABLE approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  approver_id INT NOT NULL,
  decision ENUM('Approved','Rejected') NOT NULL,
  comments TEXT,
  decided_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (approver_id) REFERENCES users(id)
);

CREATE TABLE releases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  released_by INT NOT NULL,
  released_to VARCHAR(150) NOT NULL,
  remarks TEXT,
  released_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (released_by) REFERENCES users(id)
);

CREATE TABLE tracking_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  action VARCHAR(50) NOT NULL,
  details VARCHAR(300),
  user_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE statuses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(30) NOT NULL UNIQUE
);

CREATE TABLE employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_no VARCHAR(30) NOT NULL UNIQUE,
  full_name VARCHAR(100) NOT NULL,
  position VARCHAR(80),
  email VARCHAR(100),
  department_id INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE senders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL UNIQUE,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE receivers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL UNIQUE,
  department_id INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(100),
  file_size INT,
  uploaded_by INT NOT NULL,
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  document_id INT NULL,
  message VARCHAR(255) NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  action VARCHAR(50) NOT NULL,
  document_id INT NULL,
  details VARCHAR(300),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- starting data (users are created automatically when the server first runs)
INSERT INTO departments (name) VALUES
  ('Records Office'), ('Registrar'), ('Accounting'), ('College Dean'), ('President');

INSERT INTO document_types (name) VALUES
  ('Memo'), ('Letter'), ('Request'), ('Purchase Request'), ('Travel Order');

INSERT INTO roles (name) VALUES
  ('Admin'), ('Clerk'), ('Sender'), ('Receiver'), ('Approver'), ('Office Staff');

INSERT INTO statuses (name) VALUES
  ('Registered'), ('Routed'), ('Received'), ('Returned'),
  ('Approved'), ('Rejected'), ('Released'), ('Archived');

INSERT INTO employees (employee_no, full_name, position, email, department_id) VALUES
  ('EMP-001', 'Maria Santos', 'Records Officer', 'maria@school.edu', 1),
  ('EMP-002', 'Juan Dela Cruz', 'Registrar Staff', 'juan@school.edu', 2),
  ('EMP-003', 'Ana Reyes', 'Accountant', 'ana@school.edu', 3);

-- links added after all tables exist (WP10-WP13)

ALTER TABLE documents
  ADD COLUMN sender_id INT NULL AFTER origin_dept_id,
  ADD CONSTRAINT fk_documents_sender FOREIGN KEY (sender_id) REFERENCES senders(id);

ALTER TABLE routing
  ADD COLUMN receiver_id INT NULL AFTER to_dept_id,
  ADD COLUMN due_date DATE NULL AFTER instructions,
  ADD CONSTRAINT fk_routing_receiver FOREIGN KEY (receiver_id) REFERENCES receivers(id);

ALTER TABLE routing
  MODIFY status ENUM('Pending','Received','Returned','Rejected') NOT NULL DEFAULT 'Pending';

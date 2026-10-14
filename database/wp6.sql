-- WP6: add the Sender and Office Staff roles to the users table.
-- Run once in MySQL Workbench (new SQL tab, then the lightning bolt). Your data is kept.
USE dts_db;
ALTER TABLE users
  MODIFY role ENUM('admin','clerk','sender','receiver','approver','office_staff') NOT NULL;

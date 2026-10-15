-- WP10-WP13: link documents to senders, add an assigned receiver and due date to routing,
-- and allow receivers to reject a document.
-- Run ONCE in MySQL Workbench: open a new SQL tab, paste, press Ctrl+A, then click the lightning bolt.
USE dts_db;

ALTER TABLE documents
  ADD COLUMN sender_id INT NULL AFTER origin_dept_id,
  ADD CONSTRAINT fk_documents_sender FOREIGN KEY (sender_id) REFERENCES senders(id);

ALTER TABLE routing
  ADD COLUMN receiver_id INT NULL AFTER to_dept_id,
  ADD COLUMN due_date DATE NULL AFTER instructions,
  ADD CONSTRAINT fk_routing_receiver FOREIGN KEY (receiver_id) REFERENCES receivers(id);

ALTER TABLE routing
  MODIFY status ENUM('Pending','Received','Returned','Rejected') NOT NULL DEFAULT 'Pending';

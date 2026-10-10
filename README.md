# Document Tracking System (simple version)

Stack: HTML, CSS, JavaScript (browser) + Node.js (server) + MySQL 8.0. No XAMPP needed.

## Setup (one time)
1. Install Node.js (LTS) from https://nodejs.org
2. Open this folder in Visual Studio Code (File > Open Folder).
3. Open MySQL Workbench 8.0 > connect > File > Open SQL Script > `database/schema.sql` > click the lightning bolt (Execute).
4. In VS Code, open `.env` and change `DB_PASSWORD` to your MySQL root password.
5. In VS Code: Terminal > New Terminal, then run:
       npm install
       npm start
6. Open http://localhost:3000 in your browser.

## Test accounts
| Username  | Password     | Role                       |
|-----------|--------------|----------------------------|
| admin     | admin123     | Admin (Records Office)     |
| clerk     | clerk123     | Clerk (Records Office)     |
| registrar | registrar123 | Receiver (Registrar)       |
| dean      | dean123      | Approver (College Dean)    |

## Demo flow
clerk: Register document > open it > Route to Registrar
registrar: open it > Receive > Route onward to College Dean
dean: open it > Receive > Approve
clerk: open it > Release
Anyone: open the document to see the full tracking history.

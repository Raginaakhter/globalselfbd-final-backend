# globalselfbd-final-backend

Backend API for the GlobalShelfBD e-commerce site. Built with Express 5, MongoDB (Mongoose 9) and strict TypeScript.

## Features

- Register/login with access + refresh tokens, and password reset by email OTP
- Permission-based access control with four default roles (Admin, Manager, Salesman, Customer) and an activity log
- Categories with sub-categories, and products with prices, stock, sizes, units and images
- Image upload to Cloudinary
- Cart, checkout and orders, with stock updated safely inside database transactions
- Admin order management: status, payment status, search, filters and pagination
- Order and OTP emails sent through Resend
- API documentation with Swagger

## Setup

Requirements: Node.js 20 or newer, and a MongoDB database (MongoDB Atlas works).

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

The server starts on http://localhost:5000. On the first start it creates the roles, the permissions and an Admin account from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.

API docs: http://localhost:5000/api-docs

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start in development mode and restart when a file changes |
| `npm run typecheck` | Check TypeScript types |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build (production) |

## Project structure

```
src/
  server.ts      App setup and startup
  config/        Permissions, roles, order and product options, database seed
  models/        Mongoose models
  controllers/   Request handlers
  routes/        API routes
  middleware/    Authentication, permissions, uploads, errors
  utils/         Shared helpers (tokens, checkout, emails, images, ...)
docs/swagger.json   API documentation
```

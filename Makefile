.PHONY: install migrate seed dev-api dev-admin dev stop

install:
	cd apps/api && npm install
	cd apps/admin && npm install

migrate:
	cd apps/api && DATABASE_URL=postgresql://analytics:analytics_secret@localhost:5432/analytics_db npx prisma migrate dev --name init

seed:
	cd apps/api && npx tsx src/db/seed.ts

dev-api:
	cd apps/api && npm run dev

dev-admin:
	cd apps/admin && npm run dev

dev:
	@echo "Starting API and Admin Panel..."
	@$(MAKE) dev-api &
	@$(MAKE) dev-admin &
	@wait

generate:
	cd apps/api && npx prisma generate

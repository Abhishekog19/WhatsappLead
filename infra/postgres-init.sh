#!/bin/bash
#
# Creates the role the application connects as.
#
# Mounted into /docker-entrypoint-initdb.d/, so it runs once when the data
# volume is first initialised — before the app or the migration container
# ever connect.
#
# Why this exists at all: the official Postgres image creates POSTGRES_USER as
# a SUPERUSER, and Postgres exempts superusers from row-level security. `force
# row level security` does not change that. An application connecting as
# POSTGRES_USER therefore has every tenant-isolation policy silently skipped —
# queries all succeed, nothing looks wrong, and one account's data is one
# missing `where` clause away from another's.
#
# So the superuser is used only to own the schema and run migrations, and the
# app gets this deliberately unprivileged role instead. @wa/db's
# assertTenantIsolation refuses to boot if that is ever not the case.

set -euo pipefail

if [[ -z "${POSTGRES_APP_PASSWORD:-}" ]]; then
	echo "postgres-init: POSTGRES_APP_PASSWORD is not set; refusing to create a passwordless app role" >&2
	exit 1
fi

psql -v ON_ERROR_STOP=1 \
	--username "$POSTGRES_USER" \
	--dbname "$POSTGRES_DB" \
	--set app_password="$POSTGRES_APP_PASSWORD" <<-'SQL'
	do $$
	begin
	  if not exists (select 1 from pg_roles where rolname = 'wa_app') then
	    create role wa_app login nosuperuser nobypassrls nocreatedb nocreaterole;
	  end if;
	end
	$$;

	-- Set separately so re-running updates the password without needing to know
	-- whether the role already existed.
	alter role wa_app with login nosuperuser nobypassrls password :'app_password';

	grant connect on database :"POSTGRES_DB" to wa_app;
SQL

echo "postgres-init: wa_app role ready (non-superuser, NOBYPASSRLS)"

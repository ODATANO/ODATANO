# SAP BTP Cloud Foundry Deployment - Learnings

Documentation of lessons learned from deploying ODATANO to SAP BTP Cloud Foundry Trial.

---

## 1. HTML5 Application Repository - App Naming

**Problem:** 503 Service Temporarily Unavailable when accessing the wallet-viewer app.

**Root Cause:** The HTML5 Application Repository removes dots (`.`) from app names.

**Example:**
- App ID in `manifest.json`: `odatanoview.walletviewer`
- Name in HTML5 Repo: `odatanoviewwalletviewer` (without dot)

**Solution:** Use the correct name without dots in `app/router/xs-app.json`:

```json
{
  "welcomeFile": "/odatanoviewwalletviewer/index.html",
  "routes": [
    {
      "source": "^/odatanoviewwalletviewer/(.*)$",
      "target": "/odatanoviewwalletviewer/$1",
      "service": "html5-apps-repo-rt"
    }
  ]
}
```

**Diagnostic Command:**
```bash
cf html5-list -di odatano-destination-service -u
```

---

## 2. xs-app.json in HTML5 App Deployment

**Problem:** 500 Internal Server Error - "Application does not have xs-app.json"

**Root Cause:** The `xs-app.json` was not included in the wallet-viewer app ZIP archive.

**Solution:** Add the file to `additionalFiles` in `app/wallet-viewer/ui5.yaml`:

```yaml
builder:
  customTasks:
    - name: ui5-task-zipper
      afterTask: generateVersionInfo
      configuration:
        archiveName: wallet-viewer
        additionalFiles:
          - xs-app.json
```

---

## 3. Database Deployer Module

**Problem:** SqlError - "Could not find table or view LEDGERPROTOCOLPARAMETERS"

**Root Cause:** The `db-deployer` module was missing in `mta.yaml`, so HDI container artifacts were not deployed.

**Solution:** Add `odatano-db-deployer` module to `mta.yaml`:

```yaml
modules:
  - name: odatano-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: odatano-db
```

---

## 4. Database Configuration: SQLite (Dev) vs HANA (Prod)

**Concept:** SAP CAP supports multiple database backends. Use SQLite for fast local development and HANA Cloud for production.

### Local Development (SQLite)

**`package.json` - cds configuration for development with persistent SQLite:**
```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sqlite",
        "credentials": {
          "url": "db.sqlite"
        }
      }
    }
  }
}
```

**Start locally:**
```bash
cds watch
```

This creates/uses a persistent `db.sqlite` file in the project root, preserving data between restarts.

> **Note:** Add `db.sqlite` to `.gitignore` to avoid committing local database state.

### Production (HANA Cloud)

**`package.json` - cds configuration for production:**
```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sql"
      },
      "[production]": {
        "db": {
          "kind": "hana"
        }
      }
    }
  }
}
```

**Key Points:**
- The `[production]` profile is automatically activated when `NODE_ENV=production`
- BTP Cloud Foundry sets `NODE_ENV=production` by default
- The `db-deployer` module handles HDI container deployment to HANA

### Profile-based Configuration

You can also use custom profiles:

```json
{
  "cds": {
    "requires": {
      "db": {
        "kind": "sql"
      },
      "[development]": {
        "db": { "kind": "sqlite" }
      },
      "[production]": {
        "db": { "kind": "hana" }
      }
    }
  }
}
```

**Run with specific profile:**
```bash
# Local with SQLite
cds watch --profile development

# Production with HANA
cds build --profile production

### MTA Configuration for HANA

In `mta.yaml`, the db-deployer module and hana service are required:

```yaml
modules:
  - name: odatano-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: odatano-db

resources:
  - name: odatano-db
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared
```

## 6. Build Workflow with WSL/Ubuntu

**Problem:** `mbt build` doesn't work on Windows (MSYS/Git Bash).

**Solution:** Create a build script for WSL (`build-ubuntu.sh`):

```bash
#!/bin/bash
set -e

WINDOWS_PROJECT="/mnt/c/Users/max/ODATANO"
UBUNTU_PROJECT="$HOME/ODATANO"

# Sync from Windows to Ubuntu (exclude node_modules, .git, gen, mta_archives)
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'gen' \
  --exclude 'mta_archives' \
  --exclude 'app/wallet-viewer/dist' \
  "$WINDOWS_PROJECT/" "$UBUNTU_PROJECT/"

cd "$UBUNTU_PROJECT"

# Install dependencies and build
npm ci
mbt build

# Copy build artifacts back to Windows
cp -r mta_archives "$WINDOWS_PROJECT/"
```

**Usage:**
```bash
# In WSL/Ubuntu
chmod +x build-ubuntu.sh
./build-ubuntu.sh

# Deploy from Windows or WSL
cf deploy mta_archives/odatano_0.2.0.mtar
```

---

## 8. Approuter Routing Configuration

**Complete `app/router/xs-app.json`:**

```json
{
  "welcomeFile": "/odatanoviewwalletviewer/index.html",
  "authenticationMethod": "route",
  "routes": [
    {
      "source": "^/odata/(.*)$",
      "target": "/odata/$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa",
      "csrfProtection": false
    },
    {
      "source": "^/odatanoviewwalletviewer/(.*)$",
      "target": "/odatanoviewwalletviewer/$1",
      "service": "html5-apps-repo-rt",
      "authenticationType": "xsuaa"
    },
    {
      "source": "^/(.*)$",
      "target": "$1",
      "destination": "srv-api",
      "authenticationType": "xsuaa"
    }
  ]
}
```

---

## 9. Useful CF Commands

```bash
# View logs in real-time
cf logs odatano-srv

# Check app status
cf apps

# List services
cf services

# Set environment variables
cf set-env <app-name> <VAR_NAME> "<value>"

# Restart app (without restaging)
cf restart <app-name>

# Restage app with new buildpack
cf restage <app-name>

# List HTML5 apps in repository
cf html5-list -di odatano-destination-service -u

# Deploy MTA
cf deploy mta_archives/odatano_0.2.0.mtar
```

---

## 10. Important Files for BTP Deployment

| File | Purpose |
|------|---------|
| `mta.yaml` | Multi-Target Application Descriptor |
| `xs-security.json` | XSUAA Security Configuration |
| `app/router/xs-app.json` | Approuter Routing Rules |
| `app/router/package.json` | Approuter Dependencies |
| `app/wallet-viewer/xs-app.json` | HTML5 App Routing (included in ZIP) |
| `app/wallet-viewer/ui5.yaml` | UI5 Build Configuration |

---

## 11. Architecture Overview

```
BTP Cloud Foundry
├── odatano-srv (CAP Node.js Backend)
│   ├── CardanoODataService
│   ├── CardanoTransactionService
│   └── CardanoSigningService
│
├── odatano-db-deployer (HDI Container Deployment)
│   └── Deploys schema to HANA Cloud
│
├── odatano (Approuter)
│   ├── Authentication (XSUAA)
│   ├── Routing to srv-api
│   └── Routing to HTML5 Apps
│
├── odatano-html5-repo-host (HTML5 App Repository)
│   └── wallet-viewer.zip
│
└── Services
    ├── odatano-db (HANA Cloud HDI)
    ├── odatano-auth (XSUAA)
    ├── odatano-destination-service
    └── odatano-html5-repo-runtime
```

---

*Created: January 30, 2026*

# POS System Merge Guide - Execution Plan

**Date**: May 21, 2026  
**Source**: D:\CODE\pos_system (current) + D:\CODE\NEXA POS\admin_dashboard\front (to merge)  
**Target**: D:\CODE\pos_system (updated with NEXA design system)

---

## Overview

This merge combines two React POS applications while:
- Adopting the **NEXA POS design system** (CSS variables, global CSS, clean typography)
- **Preserving functionality** from both admin and cashier apps
- **Consolidating duplicates** where possible
- **Modernizing the styling approach** (CSS Modules → Global CSS)

---

## Phase 1: CSS & Styling System ✅ COMPLETED

### What Was Done:
- ✅ Created `src/global.css` with complete NEXA design system
- ✅ Includes all CSS variables, component classes, and layouts
- ✅ Ready for import in main.jsx

### Next: Update main.jsx
```jsx
// In src/main.jsx, add import before App:
import './global.css'  // Add this line
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
```

---

## Phase 2: Component Updates (PRIORITY)

All components need to be refactored from CSS Modules to global CSS classes.

### 2.1 Button Component
**File**: `src/components/common/Button.jsx`

**Current**: Uses `styles.btn`, `styles['btn-primary']`, etc.  
**New**: Use global CSS classes like `className="btn btn-primary"`

**Action**: Replace component to use global classes:
```jsx
// OLD: className={`${styles.btn} ${variantClass} ${sizeClass}`}
// NEW: className={`btn btn-${variant} btn-${size}`}
```

Delete: `src/components/common/Button.module.css`

---

### 2.2 Card Component
**File**: `src/components/common/Card.jsx`

**Changes**:
- Remove import of Card.module.css
- Use classes: `card`, `card-header`, `card-title`, `card-subtitle`, `card-content`, `card-p-lg`
- Support padding variants with `card-p-sm`, `card-p-md`, `card-p-lg`

```jsx
// Replace styles object references with global classes
<div className={`card ${padding ? `card-p-${padding}` : 'card-p-lg'}`}>
```

Delete: `src/components/common/Card.module.css`

---

### 2.3 Input Component
**File**: `src/components/common/Input.jsx`

**New classes**:
- `.input` - main input style
- `.field` - wrapper for label + input
- `.field label` - label styling
- `.input:focus` - focus state with primary color

```jsx
// Wrapper
<div className="field">
  <label>{label}</label>
  <input className="input" type={type} ... />
</div>
```

Delete: `src/components/common/Input.module.css`

---

### 2.4 Modal Component  
**File**: `src/components/common/Modal.jsx`

**New classes**:
- `.modal-overlay` - backdrop
- `.modal` - container
- `.modal-head` - header with title
- `.modal-body` - content area
- `.modal-foot` - footer with buttons

```jsx
<div className="modal-overlay">
  <div className="modal">
    <div className="modal-head">
      <h3>{title}</h3>
    </div>
    <div className="modal-body">{children}</div>
    <div className="modal-foot">{footer}</div>
  </div>
</div>
```

Delete: `src/components/common/Modal.module.css`

---

### 2.5 Badge Component
**File**: `src/components/common/Badge.jsx`

**New classes**:
- `.badge` - base
- `.badge-success`, `.badge-warning`, `.badge-danger`, `.badge-info` - variants

```jsx
<span className={`badge badge-${variant}`}>{children}</span>
```

Delete: `src/components/common/Badge.module.css`

---

### Files to Delete (CSS Modules - replaced by global.css)
```
src/components/common/Button.module.css
src/components/common/Card.module.css
src/components/common/Input.module.css
src/components/common/Modal.module.css
src/components/common/Badge.module.css
src/components/common/Table.module.css
src/components/layout/MainLayout.module.css
src/components/layout/Sidebar.module.css
src/styles/global.module.css
src/index.module.css
src/App.module.css
src/pages/RoleSelection.module.css
src/cashier-pos/styles/Cashier.module.css
src/cashier-pos/styles/CashierLogin.module.css
src/admin-page/index.css
```

---

## Phase 3: Admin Pages Consolidation

### Structure:
NEXA POS has these pages (already complete):
- Dashboard
- Inventory  
- ProductManagement
- CashierManagement
- Analytics
- ActivityLogs
- Login
- RoleSelect

**Decision**: Use NEXA versions as they're more polished. Current pos_system versions can be archived.

### Pages to Copy from NEXA POS → pos_system:
All files from `D:\CODE\NEXA POS\admin_dashboard\front\src\pages\` can be reviewed for better implementations

---

## Phase 4: Component Consolidation

### Components to Review for Consolidation:

**From NEXA POS** (already built with new design system):
- `AdminLayout.jsx` - Modern layout component
- `Sidebar.jsx` - Dark sidebar with nav
- `PageHeader.jsx` - Page title bar
- `StatCard.jsx` - Dashboard stat cards
- Charts (BarChart, DonutChart, LineChart)

**Action**: Keep NEXA versions, update imports in pos_system pages

---

## Phase 5: Structure Reorganization

### Current Structure:
```
src/
  admin-page/        ← Can consolidate with pages/
    components/
    pages/
  cashier-pos/       ← Keep separate for now
  components/        ← Shared, clean up CSS imports
  pages/             ← Admin pages
  styles/            ← Delete (moved to global.css)
```

### Recommended Final Structure:
```
src/
  components/
    common/          ← Shared UI (Button, Card, Input, Modal, Badge)
    admin/           ← Admin-only components
    cashier/         ← Cashier-only components
  pages/
    admin/           ← Admin pages
    auth/            ← Login, RoleSelect
    cashier/         ← Cashier pages
  layouts/           ← AdminLayout, etc.
  styles/
    global.css       ← Design system (already created ✅)
  App.jsx
  main.jsx
```

---

## Phase 6: Update Main Entry Point

### `src/main.jsx` - Add global CSS import:
```jsx
import './styles/global.css'  // Add this
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

### OR move global.css to styles folder first:
```bash
mv src/global.css src/styles/global.css
```

---

## Phase 7: Package.json Update

### Keep all dependencies from pos_system (newer versions):
- React ^19.2.6 ✅ (NEXA has 18.3.1 - use newer)
- react-dom ^19.2.6 ✅ (NEXA has 18.3.1)
- react-router-dom ^7.0.0 ✅ (NEXA has 6.26.2 - use newer)
- react-bootstrap-icons ^1.11.6 ✅ (NEXA doesn't have - keep)

No changes needed - pos_system versions are already better.

---

## Phase 8: Update All Component Imports

### All components currently importing CSS modules:
Find and replace pattern:
```jsx
// BEFORE:
import styles from './Button.module.css'
className={styles.btn}

// AFTER:
// (no import needed)
className="btn btn-primary"
```

**Files to update**:
- src/components/common/*.jsx (all)
- src/components/layout/*.jsx (all)
- src/pages/*.jsx (remove CSS imports)
- src/admin-page/pages/*.jsx
- src/cashier-pos/pages/*.jsx

---

## Testing Checklist

After applying changes:
- [ ] `npm run dev` - No errors, app runs
- [ ] Admin dashboard loads with new design
- [ ] All buttons render correctly with new classes
- [ ] Cards, modals, inputs work with global CSS
- [ ] Cashier section still functional
- [ ] No console errors about missing CSS
- [ ] Responsive design works (mobile view)

---

## Execution Order (Recommended)

1. ✅ **Done**: Create global.css with design system
2. **Next**: Update main.jsx to import global.css
3. **Next**: Refactor Button, Card, Input, Modal, Badge components
4. **Then**: Delete all .module.css files
5. **Then**: Update all imports throughout the project
6. **Then**: Reorganize folder structure
7. **Finally**: Test everything

---

## Important Notes

- **Backwards compatibility**: These changes will break existing CSS module imports until all components are updated
- **Incremental approach**: Update one component type at a time and test
- **Cashier app**: Keep mostly unchanged - it works, just update CSS imports
- **Admin app**: Modernize with new design system
- **No new dependencies**: This merge doesn't require any new npm packages

---

## Questions to Consider

1. Should cashier app use same design system as admin, or keep current design?
2. Are there specific pages/features in NEXA POS that should replace current ones?
3. Should we reorganize folder structure now or later?


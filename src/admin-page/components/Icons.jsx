/* Lightweight inline SVG icon set — no external dependency. */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }

function Svg({ size = 18, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...S}>{children}</svg>
  )
}

export const IconDashboard = (p) => <Svg {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>
export const IconBox = (p) => <Svg {...p}><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></Svg>
export const IconTag = (p) => <Svg {...p}><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z" /><circle cx="8" cy="8" r="1.6" /></Svg>
export const IconUsers = (p) => <Svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13A4 4 0 0 1 16 11" /></Svg>
export const IconChart = (p) => <Svg {...p}><path d="M3 3v18h18" /><path d="M7 14l4-5 4 3 5-7" /></Svg>
export const IconList = (p) => <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></Svg>
export const IconCloud = (p) => <Svg {...p}><path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.7 1.7A3.5 3.5 0 0 0 6 18z" /><path d="M12 12v6M9.5 14.5L12 12l2.5 2.5" /></Svg>
export const IconUserPlus = (p) => <Svg {...p}><path d="M14 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="7.5" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></Svg>
export const IconLogout = (p) => <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></Svg>
export const IconDollar = (p) => <Svg {...p}><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></Svg>
export const IconPeso = (p) => <Svg {...p}><path d="M8 3v18" /><path d="M8 4h6.2a4.2 4.2 0 0 1 0 8.4H8" /><path d="M5 8h13" /><path d="M5 12h13" /></Svg>
export const IconRevenue = (p) => <Svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M21 7v6h-6" /></Svg>
export const IconCalendar = (p) => <Svg {...p}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></Svg>
export const IconAlert = (p) => <Svg {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></Svg>
export const IconSearch = (p) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Svg>
export const IconPlus = (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const IconEdit = (p) => <Svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></Svg>
export const IconTrash = (p) => <Svg {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></Svg>
export const IconClose = (p) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>
export const IconScan = (p) => <Svg {...p}><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M3 12h18" /></Svg>
export const IconBarcode = (p) => <Svg {...p}><path d="M4 5v14M8 5v14M12 5v14M16 5v14M20 5v14" /><path d="M6 5v14M14 5v14M18 5v14" /></Svg>
export const IconImage = (p) => <Svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.8" /><path d="M21 15l-5-5L5 21" /></Svg>
export const IconUpload = (p) => <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5M12 3v12" /></Svg>
export const IconDownload = (p) => <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></Svg>
export const IconCheck = (p) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
export const IconShield = (p) => <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Svg>
export const IconLock = (p) => <Svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>
export const IconCart = (p) => <Svg {...p}><circle cx="9" cy="21" r="1.6" /><circle cx="19" cy="21" r="1.6" /><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" /></Svg>
export const IconBell = (p) => <Svg {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></Svg>
export const IconMenu = (p) => <Svg {...p}><path d="M3 6h18M3 12h18M3 18h18" /></Svg>
export const IconClock = (p) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></Svg>
export const IconArrowSwap = (p) => <Svg {...p}><path d="M7 10l-4 4 4 4M3 14h18M17 4l4 4-4 4M21 8H3" /></Svg>
export const IconSettings = (p) => <Svg {...p}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" /><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.1 2.1 0 0 1-2.97 2.97l-.04-.04a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.65V21.4a2.1 2.1 0 0 1-4.2 0v-.06a1.8 1.8 0 0 0-1.18-1.69 1.8 1.8 0 0 0-1.98.36l-.04.04a2.1 2.1 0 0 1-2.97-2.97l.04-.04A1.8 1.8 0 0 0 4 15.02a1.8 1.8 0 0 0-1.65-1.1H2.2a2.1 2.1 0 0 1 0-4.2h.06A1.8 1.8 0 0 0 4 8.55a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.1 2.1 0 0 1 2.97-2.97l.04.04A1.8 1.8 0 0 0 8.59 4a1.8 1.8 0 0 0 1.1-1.65V2.2a2.1 2.1 0 0 1 4.2 0v.06A1.8 1.8 0 0 0 15 4a1.8 1.8 0 0 0 1.98-.36l.04-.04a2.1 2.1 0 0 1 2.97 2.97l-.04.04A1.8 1.8 0 0 0 19.6 8.6a1.8 1.8 0 0 0 1.65 1.1h.15a2.1 2.1 0 0 1 0 4.2h-.06A1.8 1.8 0 0 0 19.4 15z" /></Svg>

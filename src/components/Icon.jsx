// Small inline stroke icon set (Lucide-style geometry) so the UI needs no icon dependency.
const PATHS = {
  play: <path d="M7 4.5v15l12-7.5z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  camera: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  cameraOff: (
    <>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <path d="M3 3l18 18" />
    </>
  ),
  download: <path d="M12 4v11m-5-5 5 5 5-5M5 20h14" />,
  trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" />,
  pause: <path d="M9 5v14M15 5v14" />,
  table: <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />,
  alert: <path d="M12 3 2 20h20zM12 10v4m0 3v.01" />,
  face: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 10v.01M15 10v.01M9 15c1.5 1.3 4.5 1.3 6 0" />
    </>
  ),
  hand: <path d="M8 13V6a1.5 1.5 0 0 1 3 0v5m0-6a1.5 1.5 0 0 1 3 0v6m0-4a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2.5-4a1.5 1.5 0 0 1 2.5-1.6L8 15" />,
  wind: <path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  archive: <path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8v.01" />
    </>
  ),
  check: <path d="m5 12 4.5 4.5L19 7" />,
  minus: <path d="M6 12h12" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 21 9.8C21 6 17 3 12 3z" />
      <circle cx="7.5" cy="11" r=".5" />
      <circle cx="10" cy="7" r=".5" />
      <circle cx="15" cy="7" r=".5" />
    </>
  ),
  reset: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
};

export default function Icon({ name, size = 18, label }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

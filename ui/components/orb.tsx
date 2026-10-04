import type { CSSProperties } from "react";

export function Orb({ energy, active }: { energy: number; active: boolean }) {
  return (
    <div className={`orb ${active ? "orb-active" : ""}`} style={{ "--energy": Math.min(energy, 1) } as CSSProperties} aria-hidden="true">
      <div className="orb-halo" />
      <div className="orb-body">
        <svg viewBox="0 0 320 320" className="orb-liquid">
          <defs>
            <radialGradient id="orb-fill" cx="35%" cy="20%" r="90%">
              <stop offset="0" stopColor="#eaf8ff" /><stop offset="0.34" stopColor="#9bd4ff" />
              <stop offset="0.66" stopColor="#568bed" /><stop offset="1" stopColor="#203881" />
            </radialGradient>
            <linearGradient id="orb-ribbon" x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#fff" stopOpacity="0.9" /><stop offset="1" stopColor="#cfedff" stopOpacity="0.05" />
            </linearGradient>
            <filter id="orb-flow" x="-40%" y="-40%" width="180%" height="180%">
              <feTurbulence type="fractalNoise" baseFrequency="0.011 0.016" numOctaves="2" seed="8" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale={32 + energy * 36} xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </defs>
          <circle cx="160" cy="160" r="160" fill="url(#orb-fill)" />
          <g className="orb-ribbons" filter="url(#orb-flow)">
            <path d="M-30 140 Q95 -40 205 150 T380 125" fill="none" stroke="url(#orb-ribbon)" strokeWidth="74" />
            <path d="M10 250 Q110 100 240 230 T360 190" fill="none" stroke="#c4e9ff" strokeOpacity=".47" strokeWidth="33" />
            <path d="M-20 60 Q130 30 190 145 T340 260" fill="none" stroke="#fff" strokeOpacity=".32" strokeWidth="12" />
          </g>
        </svg>
        <div className="orb-sheen" />
      </div>
      <div className="orb-shadow" />
    </div>
  );
}

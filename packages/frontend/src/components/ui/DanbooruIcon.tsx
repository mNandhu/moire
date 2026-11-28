import { useId } from "react";

/** Danbooru's box mark (its favicon), sized like a lucide icon. */
export function DanbooruIcon({ size = 14, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={id} gradientTransform="rotate(85)">
          <stop offset="49%" stopColor="#ba9570" />
          <stop offset="67%" stopColor="#a4815f" />
        </linearGradient>
      </defs>
      <path
        d="M 1.5,14.5 V 4.25 L 4.25,1.5 H 14.5 v 10.25 l -2.75,2.75 z"
        fill={`url(#${id})`}
        stroke="black"
        strokeWidth="1"
      />
      <path d="m 1.5,4.5 h 10 v 10" stroke="black" strokeWidth="1" fill="none" />
      <path d="m 14.5,1.5 -3,3" stroke="black" strokeWidth="1" />
    </svg>
  );
}

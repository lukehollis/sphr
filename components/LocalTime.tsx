"use client";

import { useEffect, useState } from "react";

/** A time in the reader's own time zone; the server's rendering (UTC) shows until the page hydrates. */
export default function LocalTime({ value, dateOnly = false }: { value: string; dateOnly?: boolean }) {
  const [text, setText] = useState(value.slice(0, dateOnly ? 10 : 16).replace("T", " "));
  useEffect(() => {
    const date = new Date(value);
    setText(date.toLocaleString(undefined, dateOnly ? { month: "short", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  }, [value, dateOnly]);
  return <time dateTime={value}>{text}</time>;
}

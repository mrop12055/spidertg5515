import React from "react";

const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<]+)/gi;

function normalizeHref(url: string) {
  if (url.startsWith("www.")) return `https://${url}`;
  return url;
}

function splitTrailingPunctuation(url: string) {
  // Remove common trailing punctuation that often follows URLs in sentences.
  // Example: "https://a.com)." -> url="https://a.com", trailing=")."
  const match = url.match(/^(.*?)([\)\]\}\.,!?;:]+)$/);
  if (!match) return { url, trailing: "" };
  return { url: match[1], trailing: match[2] };
}

// Helper to convert newlines to <br/> elements in a string
function textWithLineBreaks(str: string, keyPrefix: string): React.ReactNode[] {
  const lines = str.split('\n');
  const result: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) {
      result.push(<br key={`${keyPrefix}-br-${i}`} />);
    }
    if (line) {
      result.push(line);
    }
  });
  return result;
}

export function LinkifiedText({
  text,
  linkClassName,
}: {
  text: string;
  linkClassName?: string;
}) {
  if (!text) return null;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let partIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const raw = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      const textBefore = text.slice(lastIndex, index);
      parts.push(...textWithLineBreaks(textBefore, `text-${partIndex++}`));
    }

    const { url, trailing } = splitTrailingPunctuation(raw);
    const href = normalizeHref(url);

    parts.push(
      <a
        key={`link-${partIndex++}-${index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={
          linkClassName ??
          "underline underline-offset-2 decoration-current text-inherit hover:opacity-90"
        }
      >
        {url}
      </a>
    );

    if (trailing) {
      parts.push(...textWithLineBreaks(trailing, `trailing-${partIndex++}`));
    }

    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    parts.push(...textWithLineBreaks(remaining, `end-${partIndex}`));
  }

  return <>{parts}</>;
}

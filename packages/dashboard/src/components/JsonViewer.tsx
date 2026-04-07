import type { ReactNode } from 'react';

interface JsonViewerProps {
  value: any;
  title?: ReactNode;
  maxHeightClassName?: string;
}

export function JsonViewer({ value, title, maxHeightClassName = 'max-h-[420px]' }: JsonViewerProps) {
  return (
    <div>
      {title ? <div className="text-xs font-semibold text-gray-700 mb-2">{title}</div> : null}
      <pre className={`text-xs text-gray-800 whitespace-pre-wrap break-words overflow-auto ${maxHeightClassName}`}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

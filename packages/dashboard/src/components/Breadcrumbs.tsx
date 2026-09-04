interface BreadcrumbItem {
  label: string;
  onClick?: () => void | Promise<void>;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav className="bg-gray-50 border-b border-gray-200 px-6 py-3">
      <ol className="flex items-center space-x-2 text-sm">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;

          return (
            <li key={index} className="flex items-center">
              {index > 0 && (
                <svg
                  className="w-4 h-4 text-gray-400 mx-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              )}
              {isLast ? (
                <span className="font-medium text-gray-900">{item.label}</span>
              ) : (
                <button
                  onClick={item.onClick}
                  className="text-gray-600 hover:text-gray-900 hover:underline transition-colors"
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

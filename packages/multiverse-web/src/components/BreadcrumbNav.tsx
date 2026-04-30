import { ChevronRight } from 'lucide-react';

interface Breadcrumb {
  label: string;
  onClick?: () => void;
  active?: boolean;
}

interface BreadcrumbNavProps {
  items: Breadcrumb[];
}

export function BreadcrumbNav({ items }: BreadcrumbNavProps) {
  return (
    <nav className="text-text2 flex items-center gap-1 text-xs">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-1">
          {index > 0 && <ChevronRight className="h-3 w-3 text-gray-600" />}
          {item.onClick ? (
            <button
              onClick={item.onClick}
              className="text-text2 transition-colors hover:text-accent hover:underline"
            >
              {item.label}
            </button>
          ) : (
            <span className={item.active ? 'font-medium text-accent' : 'text-text2'}>
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}

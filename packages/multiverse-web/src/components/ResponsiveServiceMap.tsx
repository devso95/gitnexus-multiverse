import { useEffect, useState } from 'react';
import { Menu, X, ChevronRight } from 'lucide-react';

interface ResponsiveServiceMapProps {
  children: React.ReactNode;
  showSidebar?: boolean;
  sidebarContent?: React.ReactNode;
  sidebarTitle?: string;
  onMobileNavToggle?: (open: boolean) => void;
}

export function ResponsiveServiceMap({
  children,
  showSidebar = false,
  sidebarContent,
  sidebarTitle = 'Details',
  onMobileNavToggle,
}: ResponsiveServiceMapProps) {
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024,
  );

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Breakpoints: mobile (<768px), tablet (768-1024px), desktop (>1024px)
  const isMobile = windowWidth < 768;
  const isTablet = windowWidth >= 768 && windowWidth < 1024;
  const isDesktop = windowWidth >= 1024;

  useEffect(() => {
    onMobileNavToggle?.(isMobileNavOpen);
  }, [isMobileNavOpen, onMobileNavToggle]);

  // Desktop: side-by-side layout
  if (isDesktop) {
    return (
      <div className="flex h-full w-full gap-0">
        <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
        {showSidebar && sidebarContent && (
          <div className="border-border flex w-80 flex-col overflow-hidden border-l bg-surface">
            <div className="border-border text-text border-b px-4 py-3 font-semibold">
              {sidebarTitle}
            </div>
            <div className="flex-1 overflow-y-auto">{sidebarContent}</div>
          </div>
        )}
      </div>
    );
  }

  // Tablet: wider layout with drawer
  if (isTablet) {
    return (
      <div className="flex h-full w-full gap-0">
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {children}
          {showSidebar && (
            <button
              onClick={() => setIsMobileNavOpen(true)}
              className="absolute right-4 bottom-4 z-40 rounded-full bg-accent p-3 text-white shadow-lg hover:opacity-90"
            >
              <ChevronRight size={20} />
            </button>
          )}
        </div>
        {showSidebar && sidebarContent && isMobileNavOpen && (
          <div className="border-border flex w-64 flex-col overflow-hidden border-l bg-surface shadow-lg">
            <div className="border-border flex items-center justify-between border-b px-4 py-3">
              <span className="text-text font-semibold">{sidebarTitle}</span>
              <button
                onClick={() => setIsMobileNavOpen(false)}
                className="hover:bg-surface2 rounded p-1"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{sidebarContent}</div>
          </div>
        )}
      </div>
    );
  }

  // Mobile: stacked layout with drawer
  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {children}
        {showSidebar && (
          <button
            onClick={() => setIsMobileNavOpen(true)}
            className="absolute right-4 bottom-4 z-40 rounded-full bg-accent p-3 text-white shadow-lg hover:opacity-90"
          >
            <Menu size={20} />
          </button>
        )}
      </div>

      {showSidebar && sidebarContent && isMobileNavOpen && (
        <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setIsMobileNavOpen(false)} />
      )}

      {showSidebar && sidebarContent && isMobileNavOpen && (
        <div className="border-border animate-in slide-in-from-bottom absolute right-0 bottom-0 left-0 z-50 flex max-h-[80vh] flex-col rounded-t-xl border-t bg-surface shadow-2xl">
          <div className="border-border sticky top-0 flex items-center justify-between border-b bg-surface px-4 py-3">
            <span className="text-text font-semibold">{sidebarTitle}</span>
            <button
              onClick={() => setIsMobileNavOpen(false)}
              className="hover:bg-surface2 rounded p-1"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">{sidebarContent}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Hook to detect screen size and provide responsive hints
 * Usage: const { isMobile, isTablet, isDesktop } = useResponsive();
 */
export function useResponsive() {
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024,
  );

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return {
    isMobile: windowWidth < 768,
    isTablet: windowWidth >= 768 && windowWidth < 1024,
    isDesktop: windowWidth >= 1024,
    windowWidth,
  };
}

/**
 * Responsive breakpoint tailwind classes:
 * - sm: 640px
 * - md: 768px (our "tablet" breakpoint)
 * - lg: 1024px (our "desktop" breakpoint)
 * - xl: 1280px
 * - 2xl: 1536px
 *
 * Example usage:
 * <div className="w-full md:w-1/2 lg:w-2/3 px-2 md:px-4 lg:px-6" />
 */

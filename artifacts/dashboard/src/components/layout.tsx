import { Link, useLocation } from "wouter";
import { LayoutDashboard, Store, Blocks, MessageSquare, Menu } from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTrigger } from "./ui/sheet";
import { useNewOrders } from "@/hooks/use-new-orders";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, badge: true },
  { href: "/marketplace", label: "Marketplace", icon: Store },
  { href: "/integrations", label: "Integrations", icon: Blocks },
  { href: "/chat", label: "Chat Tester", icon: MessageSquare },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { newCount, markAsSeen } = useNewOrders();

  const handleDashboardClick = (href: string) => {
    if (href === "/") markAsSeen();
    navigate(href);
  };

  const NavContent = ({ onNavigate }: { onNavigate?: () => void }) => (
    <div className="flex flex-col gap-1 p-4">
      <div className="flex items-center gap-2 px-2 py-4 mb-4">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-lg">W</span>
        </div>
        <span className="font-bold text-xl tracking-tight">Woxsom AI</span>
      </div>

      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = location === item.href;
        const showBadge = item.badge && newCount > 0;

        return (
          <button
            key={item.href}
            onClick={() => {
              handleDashboardClick(item.href);
              onNavigate?.();
            }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-md transition-all text-left ${
              isActive
                ? "bg-primary text-primary-foreground font-medium"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            }`}
          >
            <Icon size={18} className="shrink-0" />
            <span className="flex-1">{item.label}</span>

            {showBadge && (
              <span
                className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold leading-none transition-all animate-in fade-in zoom-in-75 duration-300 ${
                  isActive
                    ? "bg-primary-foreground text-primary"
                    : "bg-red-500 text-white"
                }`}
              >
                {newCount > 99 ? "99+" : newCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-xs">W</span>
          </div>
          <span className="font-bold">Woxsom AI</span>
          {newCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold leading-none animate-in fade-in zoom-in-75 duration-300">
              {newCount > 99 ? "99+" : newCount}
            </span>
          )}
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="relative">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 bg-sidebar border-r-0">
            <NavContent onNavigate={() => document.body.click()} />
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden md:flex flex-col w-64 border-r bg-sidebar text-sidebar-foreground min-h-screen sticky top-0">
        <NavContent />
      </div>

      {/* Main Content */}
      <main className="flex-1 min-w-0 flex flex-col h-[100dvh] overflow-y-auto">
        <div className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </div>
  );
}

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bot, MessageSquare, ShoppingCart, Percent, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const EMPLOYEES = [
  {
    id: "malika",
    name: "Malika",
    role: "Instagram Sales Manager",
    description: "Specializes in converting Instagram DMs into sales. Friendly, uses emojis naturally, and knows how to upsell visually appealing products.",
    icon: MessageSquare,
    features: ["DM Auto-reply", "Story mention tracking", "Visual upselling"],
    color: "bg-pink-500/10 text-pink-600 border-pink-500/20"
  },
  {
    id: "aziz",
    name: "Aziz",
    role: "Telegram Support Agent",
    description: "Fast, technical, and precise. Handles FAQs, delivery tracking, and returns efficiently. Perfect for technical goods or electronics.",
    icon: Bot,
    features: ["FAQ resolution", "Order tracking", "Technical specs"],
    color: "bg-blue-500/10 text-blue-600 border-blue-500/20"
  },
  {
    id: "nilufar",
    name: "Nilufar",
    role: "Order Tracker Assistant",
    description: "Dedicated strictly to logistics. Proactively updates customers on shipping status and collects delivery feedback.",
    icon: ShoppingCart,
    features: ["Shipping updates", "Address collection", "Feedback surveys"],
    color: "bg-green-500/10 text-green-600 border-green-500/20"
  },
  {
    id: "timur",
    name: "Timur",
    role: "Promotions Bot",
    description: "Aggressive sales persona designed for flash sales and holiday discounts. Creates urgency and pushes coupon codes.",
    icon: Percent,
    features: ["Flash sale broadcasts", "Coupon distribution", "Cart recovery"],
    color: "bg-orange-500/10 text-orange-600 border-orange-500/20"
  }
];

export default function Marketplace() {
  const { toast } = useToast();

  const handleActivate = (name: string) => {
    toast({
      title: "Employee Activated",
      description: `${name} has been assigned to your active store.`,
    });
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI Employee Marketplace</h1>
        <p className="text-muted-foreground mt-1">Hire specialized AI personas to manage different aspects of your business.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        {EMPLOYEES.map((employee) => {
          const Icon = employee.icon;
          return (
            <Card key={employee.id} className="flex flex-col border-border/50 shadow-sm hover:shadow-md transition-all hover:-translate-y-1">
              <CardHeader className="pb-4">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 border ${employee.color}`}>
                  <Icon size={24} />
                </div>
                <CardTitle className="text-xl">{employee.name}</CardTitle>
                <CardDescription className="font-medium text-foreground">{employee.role}</CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm text-muted-foreground mb-6 line-clamp-3">
                  {employee.description}
                </p>
                <div className="space-y-2">
                  {employee.features.map((feature, i) => (
                    <div key={i} className="flex items-center text-sm">
                      <CheckCircle2 size={16} className="text-primary mr-2 shrink-0" />
                      <span>{feature}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t border-border/50">
                <Button 
                  className="w-full" 
                  onClick={() => handleActivate(employee.name)}
                >
                  Activate Persona
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

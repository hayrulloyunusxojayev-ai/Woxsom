import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SiTelegram, SiInstagram } from "react-icons/si";
import { Copy, CheckCircle2, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Integrations() {
  const { toast } = useToast();

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied to clipboard",
      description: "Webhook URL copied.",
    });
  };

  const domain = window.location.origin;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Integrations</h1>
        <p className="text-muted-foreground mt-1">Connect your sales channels and configure webhooks.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Telegram Integration */}
        <Card className="border-border/50 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-6 opacity-5 pointer-events-none">
            <SiTelegram size={120} />
          </div>
          <CardHeader>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#0088cc]/10 flex items-center justify-center text-[#0088cc]">
                  <SiTelegram size={24} />
                </div>
                <CardTitle>Telegram Bot</CardTitle>
              </div>
              <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 flex items-center gap-1">
                <CheckCircle2 size={12} /> Connected
              </Badge>
            </div>
            <CardDescription>
              Receive messages and process orders directly through a Telegram bot.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Webhook URL</label>
              <div className="flex gap-2">
                <Input 
                  readOnly 
                  value={`${domain}/api/webhook/platform`}
                  className="font-mono text-xs bg-muted/50"
                />
                <Button variant="secondary" size="icon" onClick={() => handleCopy(`${domain}/api/webhook/platform`)}>
                  <Copy size={16} />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Set this URL in your BotFather configuration to route messages to Woxsom.
              </p>
            </div>
            
            <div className="pt-4 border-t border-border/50 flex justify-end">
              <Button variant="outline" className="text-destructive hover:bg-destructive/10">
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Instagram Integration */}
        <Card className="border-border/50 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 right-0 p-6 opacity-5 pointer-events-none">
            <SiInstagram size={120} />
          </div>
          <CardHeader>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#E1306C]/10 flex items-center justify-center text-[#E1306C]">
                  <SiInstagram size={24} />
                </div>
                <CardTitle>Instagram DMs</CardTitle>
              </div>
              <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 flex items-center gap-1">
                <CheckCircle2 size={12} /> Connected
              </Badge>
            </div>
            <CardDescription>
              Auto-reply to Instagram Direct Messages and track story mentions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Webhook URL</label>
              <div className="flex gap-2">
                <Input 
                  readOnly 
                  value={`${domain}/api/webhook/instagram`}
                  className="font-mono text-xs bg-muted/50"
                />
                <Button variant="secondary" size="icon" onClick={() => handleCopy(`${domain}/api/webhook/instagram`)}>
                  <Copy size={16} />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Configure this webhook in your Meta Developer Portal.
              </p>
            </div>
            
            <div className="pt-4 border-t border-border/50 flex justify-end">
              <Button variant="outline" className="text-destructive hover:bg-destructive/10">
                Disconnect
              </Button>
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from "react";
import { useSendChatMessage } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Bot, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export default function ChatTester() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Hello! I am your AI Sales Assistant. How can I help you test my responses today?" }
  ]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("Qwen/Qwen2.5-72B-Instruct");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const sendMessageMutation = useSendChatMessage();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() || sendMessageMutation.isPending) return;

    const userMsg: ChatMessage = { role: "user", content: input };
    const newMessages = [...messages, userMsg];
    
    setMessages(newMessages);
    setInput("");

    sendMessageMutation.mutate(
      { data: { messages: newMessages, model } },
      {
        onSuccess: (response) => {
          setMessages([...newMessages, { role: "assistant", content: response.content }]);
        },
        onError: () => {
          toast({
            title: "Error",
            description: "Failed to get a response from the AI.",
            variant: "destructive"
          });
          // Remove the user message if it failed
          setMessages(messages);
        }
      }
    );
  };

  return (
    <div className="h-full flex flex-col space-y-4 animate-in fade-in duration-500 max-w-4xl mx-auto w-full pb-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Chat Tester</h1>
          <p className="text-muted-foreground text-sm mt-1">Test your AI employee's responses in real-time.</p>
        </div>
        <div className="w-full sm:w-64">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger>
              <SelectValue placeholder="Select Model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Qwen/Qwen2.5-72B-Instruct">Qwen 2.5 72B Instruct</SelectItem>
              <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden border-border/50 shadow-sm relative min-h-[500px]">
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-6"
        >
          {messages.map((msg, i) => (
            <div 
              key={i} 
              className={`flex gap-4 max-w-[85%] ${msg.role === 'user' ? 'ml-auto flex-row-reverse' : ''}`}
            >
              <div className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center mt-1
                ${msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'}`}
              >
                {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
              </div>
              <div className={`px-4 py-3 rounded-2xl ${
                msg.role === 'user' 
                  ? 'bg-primary text-primary-foreground rounded-tr-sm' 
                  : 'bg-muted rounded-tl-sm'
              }`}>
                {/* Basic markdown rendering substitute for simplicity, real app might use react-markdown */}
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {msg.content}
                </div>
              </div>
            </div>
          ))}
          {sendMessageMutation.isPending && (
            <div className="flex gap-4 max-w-[85%]">
              <div className="w-8 h-8 rounded-full shrink-0 bg-accent text-accent-foreground flex items-center justify-center mt-1">
                <Bot size={16} />
              </div>
              <div className="px-4 py-3 rounded-2xl bg-muted rounded-tl-sm flex items-center gap-2">
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.2s]" />
                  <span className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:0.4s]" />
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border/50 bg-card">
          <form 
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            className="flex gap-2"
          >
            <Input 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message to test the AI..."
              className="flex-1"
              disabled={sendMessageMutation.isPending}
            />
            <Button type="submit" disabled={!input.trim() || sendMessageMutation.isPending}>
              <Send size={18} className="mr-2" />
              Send
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}

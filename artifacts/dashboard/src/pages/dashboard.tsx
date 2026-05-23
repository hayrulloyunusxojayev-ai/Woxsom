import { useGetDashboardStats, useListStores, useListOrders } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Store, Users, MessageCircle, BarChart3, Activity, ShoppingBag, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats();
  const { data: stores, isLoading: storesLoading } = useListStores();
  const { data: orders, isLoading: ordersLoading } = useListOrders();

  const metrics = [
    { label: "Active Stores", value: stats?.activeStores, icon: Store, trend: "+2", color: "text-blue-500" },
    { label: "Total Leads", value: stats?.totalLeads, icon: Users, trend: "+14%", color: "text-green-500" },
    { label: "Messages Today", value: stats?.messagesToday, icon: MessageCircle, trend: "+5%", color: "text-orange-500" },
    { label: "Total Capacity", value: stats?.totalStores, icon: BarChart3, color: "text-purple-500" },
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground mt-1">Monitor your AI sales performance across all platforms.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statsLoading ? (
          Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)
        ) : (
          metrics.map((metric) => (
            <Card key={metric.label} className="border-border/50 shadow-sm hover:border-primary/20 transition-colors">
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">{metric.label}</p>
                    <p className="text-3xl font-bold">{metric.value || 0}</p>
                  </div>
                  <div className={`p-3 rounded-full bg-muted ${metric.color}`}>
                    <metric.icon size={24} />
                  </div>
                </div>
                {metric.trend && (
                  <div className="mt-4 flex items-center text-sm">
                    <Activity size={14} className="mr-1 text-primary" />
                    <span className="text-primary font-medium">{metric.trend}</span>
                    <span className="text-muted-foreground ml-1">vs last week</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
              <ShoppingBag className="text-primary" /> Recent Orders
            </h2>
          </div>
          <Card className="border-border/50 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground bg-muted/50 border-b">
                  <tr>
                    <th className="px-6 py-4 font-medium">Customer</th>
                    <th className="px-6 py-4 font-medium">Store</th>
                    <th className="px-6 py-4 font-medium">Status</th>
                    <th className="px-6 py-4 font-medium">Amount</th>
                    <th className="px-6 py-4 font-medium text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {ordersLoading ? (
                    Array(5).fill(0).map((_, i) => (
                      <tr key={i}>
                        <td colSpan={5} className="px-6 py-4"><Skeleton className="h-6 w-full" /></td>
                      </tr>
                    ))
                  ) : orders?.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                        No orders yet.
                      </td>
                    </tr>
                  ) : (
                    orders?.map((order) => (
                      <tr key={order.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-6 py-4 font-medium">
                          <div className="flex flex-col">
                            <span>{order.customerName}</span>
                            <span className="text-xs text-muted-foreground">{order.customerPhone}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">{order.storeName}</td>
                        <td className="px-6 py-4">
                          <Badge variant={order.status === 'completed' ? 'default' : 'secondary'} className="font-normal capitalize">
                            {order.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 font-medium">{order.totalPrice}</td>
                        <td className="px-6 py-4 text-right text-muted-foreground">
                          {format(new Date(order.createdAt), "MMM d, HH:mm")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Store className="text-primary" /> Active Stores
          </h2>
          <div className="space-y-3">
            {storesLoading ? (
              Array(3).fill(0).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)
            ) : stores?.length === 0 ? (
              <Card className="p-8 text-center text-muted-foreground border-dashed">
                No stores active. Head to Integrations to connect one.
              </Card>
            ) : (
              stores?.map((store) => (
                <Card key={store.id} className="border-border/50 shadow-sm hover:border-primary/20 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h3 className="font-semibold text-base">{store.storeName}</h3>
                        <p className="text-xs text-muted-foreground">@{store.botUsername}</p>
                      </div>
                      <Badge variant={store.isActive ? "default" : "destructive"} className={store.isActive ? "bg-green-500/10 text-green-600 hover:bg-green-500/20 border-0" : ""}>
                        {store.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <div className="flex items-center text-sm text-muted-foreground mt-4 gap-4">
                      <div className="flex items-center gap-1">
                        <ShoppingBag size={14} />
                        <span>{store.orderCount} orders</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock size={14} />
                        <span>{format(new Date(store.createdAt), "MMM d")}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Zap, TrendingUp, Loader2, RefreshCcw, ExternalLink, MessageCircle, CreditCard } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface CreditData {
  creditsSpent: number;
  creditsBalance: number;
  periodo: string;
}

interface Plano {
  id: number;
  nome: string;
  preco_mensal: number;
  limite_creditos: number;
  limite_usuarios: number | null;
  funcionalidades: string[];
}

const Billing = () => {
  const [creditData, setCreditData] = useState<CreditData | null>(null);
  const [plano, setPlano] = useState<Plano | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchCredits = async () => {
    try {
      setLoading(true);
      
      // Fetch credit data
      const { data: creditResponse, error: creditError } = await supabase.functions.invoke('fetch-gpt-credits');
      if (creditError) throw creditError;
      setCreditData(creditResponse);

      // Fetch user's team plan
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: profile } = await supabase
        .from('profiles')
        .select('equipe_id')
        .eq('user_id', user.id)
        .single();

      if (profile?.equipe_id) {
        const { data: equipe } = await supabase
          .from('equipes')
          .select('plano_id, planos(*)')
          .eq('id', profile.equipe_id)
          .single();

        if (equipe?.planos) {
          setPlano(equipe.planos as unknown as Plano);
        }
      }
    } catch (error: any) {
      console.error('Error fetching billing data:', error);
      toast({
        title: "Erro ao carregar dados",
        description: error.message || "Não foi possível carregar os dados de billing",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRecharge = () => {
    // Option A: WhatsApp (simple)
    window.open('https://wa.me/5511999999999?text=Olá! Gostaria de recarregar meus créditos AdvAI', '_blank');
    
    // Option B: Stripe (requires setup)
    // Will be implemented when user decides to integrate Stripe
  };

  useEffect(() => {
    fetchCredits();
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const totalCredits = (creditData?.creditsBalance || 0) + (creditData?.creditsSpent || 0);
  const usagePercentage = totalCredits > 0 ? ((creditData?.creditsSpent || 0) / totalCredits) * 100 : 0;

  return (
    <div className="flex-1 flex flex-col">
      <div className="border-b border-border bg-gradient-to-r from-background to-soft-gray">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-foreground">
            Billing <span className="text-primary">&amp; Créditos</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestão de consumo de créditos do AdvAI • {creditData?.periodo}
          </p>
        </div>
      </div>

      <div className="flex-1 container mx-auto px-4 py-6 space-y-6">
        {/* Current Plan Card */}
        {plano && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Plano Atual</CardTitle>
                  <CardDescription>Detalhes da sua assinatura</CardDescription>
                </div>
                <Badge variant="secondary" className="text-lg px-4 py-1">
                  {plano.nome}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div>
                  <p className="text-sm text-muted-foreground">Valor Mensal</p>
                  <p className="text-2xl font-bold">
                    R$ {plano.preco_mensal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Limite de Créditos</p>
                  <p className="text-2xl font-bold">{plano.limite_creditos.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Usuários</p>
                  <p className="text-2xl font-bold">
                    {plano.limite_usuarios ? plano.limite_usuarios : 'Ilimitado'}
                  </p>
                </div>
              </div>
              <div className="border-t pt-4">
                <p className="text-sm font-semibold mb-2">Funcionalidades Incluídas:</p>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {plano.funcionalidades.map((func, index) => (
                    <li key={index} className="text-sm text-muted-foreground flex items-center gap-2">
                      <span className="text-primary">✓</span>
                      {func}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Credit Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Saldo Disponível</CardTitle>
              <Zap className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{creditData?.creditsBalance || 0}</div>
              <p className="text-xs text-muted-foreground">Créditos restantes</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Consumo Mensal</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{creditData?.creditsSpent || 0}</div>
              <p className="text-xs text-muted-foreground">Créditos utilizados</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Taxa de Uso</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{usagePercentage.toFixed(1)}%</div>
              <p className="text-xs text-muted-foreground">Do total disponível</p>
            </CardContent>
          </Card>
        </div>

        {/* Usage Progress */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Consumo de Créditos</CardTitle>
                <CardDescription>Visualização do uso mensal</CardDescription>
              </div>
              <Button onClick={fetchCredits} variant="outline" size="sm">
                <RefreshCcw className="h-4 w-4 mr-2" />
                Atualizar
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Créditos Utilizados</span>
                <span className="font-medium">
                  {creditData?.creditsSpent || 0} / {totalCredits}
                </span>
              </div>
              <Progress value={usagePercentage} className="h-2" />
            </div>

            <div className="pt-4 space-y-2 border-t">
              <h3 className="font-semibold text-sm">Detalhes do Período</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Período</p>
                  <p className="font-medium">{creditData?.periodo}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium text-green-600">Ativo</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recharge Options */}
        <Card>
          <CardHeader>
            <CardTitle>Recarregar Créditos</CardTitle>
            <CardDescription>Adicione créditos extras além do seu plano mensal</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-4">
              <Button onClick={handleRecharge} className="flex-1" size="lg">
                <MessageCircle className="h-5 w-5 mr-2" />
                Recarregar via WhatsApp
              </Button>
              <Button variant="outline" className="flex-1" size="lg" disabled>
                <CreditCard className="h-5 w-5 mr-2" />
                Pagamento Online (Em breve)
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-4">
              💡 Dica: Entre em contato conosco para pacotes personalizados de créditos
            </p>
          </CardContent>
        </Card>

        {/* Warning for low credits */}
        {usagePercentage > 80 && (
          <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950">
            <CardHeader>
              <CardTitle className="text-yellow-800 dark:text-yellow-200">
                Atenção: Créditos Baixos
              </CardTitle>
              <CardDescription className="text-yellow-700 dark:text-yellow-300">
                Você já utilizou {usagePercentage.toFixed(0)}% dos seus créditos mensais.
                Clique em "Recarregar Créditos" acima para adicionar mais.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </div>
  );
};

export default Billing;

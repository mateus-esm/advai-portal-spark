import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const CRM = () => {
  const { equipe } = useAuth();

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="border-b border-border bg-gradient-to-r from-background to-soft-gray">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-foreground">CRM <span className="text-primary">Integrado</span></h1>
          <p className="text-sm text-muted-foreground mt-1">Acesso ao sistema Jestor</p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-4">
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-950">
          <CardHeader>
            <CardTitle className="text-yellow-800 dark:text-yellow-200">ℹ️ Acesso Interativo ao CRM</CardTitle>
            <CardDescription className="text-yellow-700 dark:text-yellow-300">
              A visualização abaixo é read-only. Para interagir (mover cards, editar), acesse o Jestor diretamente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a href="https://mateussmaia.jestor.fun/object/o_apnte00i6bwtdfd2rjc" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">
              Acessar CRM Interativo
            </a>
            <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-2">⚠️ O acesso interativo consome um assento do Jestor.</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex-1 relative">
        <iframe src={equipe?.crm_link} className="absolute inset-0 w-full h-full border-0" title="CRM" />
      </div>
    </div>
  );
};

export default CRM;

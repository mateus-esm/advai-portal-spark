import { useAuth } from "@/contexts/AuthContext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";

const Chat = () => {
  const { profile } = useAuth();

  if (!profile?.chat_link_base) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">Carregando chat...</p>
      </div>
    );
  }

  const chatHref = profile.chat_link_base;
  const isExternalChatLink = chatHref.startsWith("http");

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="border-b border-border bg-gradient-to-r from-background to-soft-gray">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold text-foreground">
            AdvAI <span className="text-primary">— Assistente Jurídico</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {profile.nome_completo} • Powered by Solo Ventures ⚡
          </p>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 p-4">
        {isExternalChatLink && (
          <Alert className="max-w-3xl mx-auto">
            <AlertTitle>Problemas ao carregar o chat?</AlertTitle>
            <AlertDescription>
              Alguns provedores externos bloqueiam login dentro de iframes. Abra o chat em uma nova aba
              para concluir o acesso ou habilite cookies de terceiros.
              <Button asChild variant="outline" className="mt-3">
                <a href={chatHref} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" /> Abrir chat em nova aba
                </a>
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="flex-1 relative overflow-hidden rounded-xl border border-border bg-background">
          <iframe
            src={chatHref}
            className="absolute inset-0 w-full h-full border-0"
            allow="camera *; microphone *; display-capture *"
            title="AdvAI Chat Interface"
            allowFullScreen
          />
        </div>
      </div>
    </div>
  );
};

export default Chat;

# Plano de Implementação: Sistema de Cobrança e Créditos AdvAI

## Visão Geral
Sistema integrado de cobrança recorrente vinculado ao consumo de créditos do GPT Maker, permitindo gestão financeira completa da operação SaaS.

## Fase 1: Estrutura de Dados (Supabase)

### 1.1 Tabela `planos`
```sql
CREATE TABLE public.planos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  creditos_mensais INTEGER NOT NULL,
  valor_mensal DECIMAL(10,2) NOT NULL,
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 1.2 Tabela `assinaturas`
```sql
CREATE TABLE public.assinaturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipe_id UUID REFERENCES equipes(id) NOT NULL,
  plano_id UUID REFERENCES planos(id) NOT NULL,
  status VARCHAR(20) DEFAULT 'ativa', -- ativa, cancelada, suspensa
  data_inicio DATE NOT NULL,
  data_renovacao DATE NOT NULL,
  gateway_assinatura_id VARCHAR(255), -- ID do Stripe/PagSeguro
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 1.3 Tabela `consumo_creditos`
```sql
CREATE TABLE public.consumo_creditos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  equipe_id UUID REFERENCES equipes(id) NOT NULL,
  creditos_utilizados INTEGER NOT NULL,
  tipo_consumo VARCHAR(50), -- chat_gpt, api_call, etc
  metadata JSONB, -- dados adicionais sobre o uso
  data_consumo TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 1.4 Tabela `saldo_creditos`
```sql
CREATE TABLE public.saldo_creditos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipe_id UUID REFERENCES equipes(id) UNIQUE NOT NULL,
  creditos_disponiveis INTEGER DEFAULT 0,
  creditos_mensais INTEGER DEFAULT 0,
  data_reset DATE, -- próxima data de reset mensal
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 1.5 Tabela `transacoes`
```sql
CREATE TABLE public.transacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipe_id UUID REFERENCES equipes(id) NOT NULL,
  tipo VARCHAR(50) NOT NULL, -- assinatura, pacote_creditos, reembolso
  valor DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pendente', -- pendente, aprovada, recusada
  gateway VARCHAR(20), -- stripe, pagseguro
  gateway_transacao_id VARCHAR(255),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Fase 2: Edge Functions (Integrações)

### 2.1 Webhook do Gateway de Pagamento
- **Função**: `handle-payment-webhook`
- **Propósito**: Receber notificações de pagamento aprovado/recusado
- **Ações**:
  - Atualizar status da assinatura
  - Adicionar créditos ao saldo
  - Registrar transação

### 2.2 Contabilização de Consumo
- **Função**: `track-credit-usage`
- **Propósito**: Registrar uso de créditos quando o usuário interage com o GPT
- **Ações**:
  - Decrementar saldo de créditos
  - Registrar no histórico de consumo
  - Alertar quando créditos estiverem baixos

### 2.3 Reset Mensal
- **Função**: `reset-monthly-credits`
- **Propósito**: Executar mensalmente (cron job)
- **Ações**:
  - Resetar créditos disponíveis baseado no plano
  - Atualizar data_reset

## Fase 3: Frontend (React Components)

### 3.1 Página `Billing.tsx`
**Seções:**
1. **Resumo do Plano Atual**
   - Nome do plano
   - Créditos inclusos mensalmente
   - Valor da mensalidade
   - Próxima data de renovação

2. **Saldo de Créditos**
   - Créditos disponíveis (barra de progresso)
   - Créditos utilizados no mês atual
   - Histórico de consumo (gráfico)

3. **Histórico de Transações**
   - Tabela com últimas transações
   - Status de pagamentos
   - Download de recibos

4. **Ações**
   - Comprar pacotes extras de créditos
   - Upgrade/downgrade de plano
   - Gerenciar forma de pagamento
   - Cancelar assinatura

### 3.2 Componente `CreditUsageChart.tsx`
- Gráfico de consumo diário/semanal/mensal
- Usar Recharts (já instalado)

### 3.3 Componente `CreditBalance.tsx`
- Widget reutilizável mostrando saldo
- Exibir em Dashboard/Header quando apropriado

## Fase 4: Integrações de Gateway

### 4.1 Stripe (Recomendado)
**Recursos necessários:**
- Stripe Checkout para assinaturas
- Stripe Customer Portal (gerenciar cartão, cancelar)
- Webhooks para automação

**Fluxo:**
1. Usuário seleciona plano → Redirect para Stripe Checkout
2. Stripe processa pagamento → Webhook notifica sistema
3. Sistema ativa assinatura e adiciona créditos

### 4.2 PagSeguro (Alternativa BR)
**Recursos necessários:**
- PagSeguro API para assinaturas recorrentes
- Notificações IPN para webhooks
- Integração com SDK JavaScript

## Fase 5: Políticas RLS (Row Level Security)

```sql
-- Usuários podem ver apenas dados da própria equipe
CREATE POLICY "users_view_own_team_billing"
ON saldo_creditos FOR SELECT
USING (equipe_id IN (
  SELECT equipe_id FROM profiles WHERE user_id = auth.uid()
));

CREATE POLICY "users_view_own_team_transactions"
ON transacoes FOR SELECT
USING (equipe_id IN (
  SELECT equipe_id FROM profiles WHERE user_id = auth.uid()
));

-- Apenas sistema pode inserir consumo (via Edge Function com service role)
CREATE POLICY "system_only_insert_consumption"
ON consumo_creditos FOR INSERT
WITH CHECK (false); -- forçar uso de service role key
```

## Fase 6: Cronograma de Implementação

| Semana | Tarefas |
|--------|---------|
| 1 | Criar tabelas no Supabase + RLS policies |
| 2 | Desenvolver Edge Functions (webhooks e tracking) |
| 3 | Implementar frontend (Billing.tsx + componentes) |
| 4 | Integração com Stripe/PagSeguro |
| 5 | Testes end-to-end + refinamentos |
| 6 | Deploy e monitoramento inicial |

## Considerações Técnicas

### Segurança
- Nunca expor service role key no frontend
- Validar webhooks com assinatura HMAC
- Logs de auditoria para todas transações

### Performance
- Indexar `consumo_creditos` por `equipe_id` e `data_consumo`
- Cache de saldo de créditos (Redis opcional)

### Monitoramento
- Alertas quando saldo < 10%
- Dashboard admin para visualizar métricas globais
- Relatórios mensais automáticos

## Próximos Passos Imediatos

1. ✅ Documentar plano (este arquivo)
2. ⏳ Definir gateway de pagamento (Stripe vs PagSeguro)
3. ⏳ Criar migrations das tabelas
4. ⏳ Implementar página Billing.tsx básica
5. ⏳ Integrar com GPT Maker para tracking real

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.80.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ASAAS_API_URL = 'https://api.asaas.com/v3';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const asaasApiKey = Deno.env.get('ASAAS_API_KEY');
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) throw new Error('Unauthorized');

    const { plano_id } = await req.json();

    // 1. Buscando Dados
    const { data: profile } = await supabaseClient.from('profiles').select('equipe_id, email, cpf, nome_completo').eq('user_id', user.id).single();
    const { data: equipe } = await supabaseClient.from('equipes').select('*').eq('id', profile.equipe_id).single();
    const { data: plano } = await supabaseClient.from('planos').select('*').eq('id', plano_id).single();

    let customerId = equipe.asaas_customer_id;

    // 2. Garantir Cliente no Asaas
    if (!customerId) {
      const customerRes = await fetch(`${ASAAS_API_URL}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
        body: JSON.stringify({
          name: equipe.nome_cliente,
          email: profile.email,
          cpfCnpj: profile.cpf
        })
      });
      const customerData = await customerRes.json();
      customerId = customerData.id;
      
      // Atualiza equipe com ID do Asaas
      await supabaseClient.from('equipes').update({ asaas_customer_id: customerId }).eq('id', equipe.id);
    }

    // 3. Calcular Próximo Dia 01
    const today = new Date();
    const nextDue = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextDueDate = nextDue.toISOString().split('T')[0];

    // 4. Criar Assinatura
    const subscriptionBody = {
      customer: customerId,
      billingType: 'UNDEFINED', // Cliente escolhe a forma de pagamento
      value: plano.preco_mensal,
      nextDueDate: nextDueDate,
      cycle: 'MONTHLY',
      description: `Assinatura ${plano.nome} - AdvAI`,
      externalReference: `sub_${equipe.id}` // Identificador para o Webhook
    };

    const subRes = await fetch(`${ASAAS_API_URL}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
      body: JSON.stringify(subscriptionBody)
    });

    const subData = await subRes.json();

    if (!subRes.ok) throw new Error(`Erro Asaas: ${JSON.stringify(subData)}`);

    // Atualiza status local
    await supabaseClient.from('equipes').update({ 
      asaas_subscription_id: subData.id,
      subscription_status: 'pending_payment', // Pendente até pagar
      plano_id: plano_id 
    }).eq('id', equipe.id);

    return new Response(JSON.stringify({ 
      invoiceUrl: subData.invoiceUrl // URL para o cliente pagar
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});

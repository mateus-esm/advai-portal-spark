import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ASAAS_API_URL = 'https://api.asaas.com/v3';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const asaasApiKey = Deno.env.get('ASAAS_API_KEY');
    if (!asaasApiKey) throw new Error('ASAAS_API_KEY not configured');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) throw new Error('Unauthorized');

    const { plano_id, creditCardToken } = await req.json();
    if (!plano_id) throw new Error('plano_id is required');

    const { data: profile } = await supabaseClient.from('profiles').select('equipe_id, nome_completo, email, cpf').eq('user_id', user.id).single();
    if (!profile) throw new Error('Profile not found');
    if (!profile.cpf) throw new Error('CPF necessário.');

    const { data: equipe } = await supabaseClient.from('equipes').select('id, nome_cliente, asaas_customer_id').eq('id', profile.equipe_id).single();
    if (!equipe) throw new Error('Team not found');

    const { data: plano } = await supabaseClient.from('planos').select('*').eq('id', plano_id).single();
    if (!plano) throw new Error('Plan not found');

    let customerId = equipe.asaas_customer_id;

    if (!customerId) {
      const customerRes = await fetch(`${ASAAS_API_URL}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
        body: JSON.stringify({ name: equipe.nome_cliente, email: profile.email, cpfCnpj: profile.cpf })
      });
      const customerData = await customerRes.json();
      if (!customerData.id) throw new Error('Erro ao criar cliente Asaas');
      
      customerId = customerData.id;
      const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await adminClient.from('equipes').update({ asaas_customer_id: customerId }).eq('id', equipe.id);
    }

    const today = new Date();
    const nextDue = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextDueDate = nextDue.toISOString().split('T')[0];

    const subBody: any = {
      customer: customerId,
      billingType: creditCardToken ? 'CREDIT_CARD' : 'UNDEFINED',
      value: plano.preco_mensal,
      nextDueDate: nextDueDate,
      cycle: 'MONTHLY',
      description: `Assinatura ${plano.nome}`,
      externalReference: `sub_${equipe.id}_${plano.id}`
    };

    if (creditCardToken) {
        subBody.creditCardToken = creditCardToken;
        subBody.remoteIp = req.headers.get('x-forwarded-for') || '0.0.0.0';
    }

    const subRes = await fetch(`${ASAAS_API_URL}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
      body: JSON.stringify(subBody)
    });

    const subData = await subRes.json();
    if (!subRes.ok) throw new Error(subData.errors?.[0]?.description || 'Erro na assinatura');

    const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    await adminClient.from('equipes').update({ 
        asaas_subscription_id: subData.id,
        subscription_status: 'active',
        plano_id: plano_id
    }).eq('id', equipe.id);

    return new Response(JSON.stringify({ 
      success: true, 
      subscriptionId: subData.id,
      invoiceUrl: subData.invoiceUrl 
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { headers: corsHeaders, status: 500 });
  }
});

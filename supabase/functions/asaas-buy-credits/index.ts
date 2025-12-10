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
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Validação simplificada (apenas verifica se enviou o user_id no body ou pega do header se quiser)
    // Para robustez, vamos confiar no user_id passado pelo front ou pegar do token se enviado
    const authHeader = req.headers.get('Authorization');
    let userId = null;
    
    if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        const { data: { user } } = await supabaseClient.auth.getUser(token);
        userId = user?.id;
    }

    const { amount, credits, user_id_override } = await req.json();
    const finalUserId = userId || user_id_override;

    if (!finalUserId) throw new Error('Usuário não identificado');

    // Busca dados
    const { data: profile } = await supabaseClient.from('profiles').select('equipe_id, nome_completo, email, cpf').eq('user_id', finalUserId).single();
    if (!profile?.cpf) throw new Error('CPF obrigatório no perfil.');

    const { data: equipe } = await supabaseClient.from('equipes').select('id, nome_cliente, asaas_customer_id').eq('id', profile.equipe_id).single();
    if (!equipe) throw new Error('Equipe não encontrada.');

    // 1. Garantir Cliente Asaas
    let asaasCustomerId = equipe.asaas_customer_id;
    if (!asaasCustomerId) {
       const newCustomerRes = await fetch(`${ASAAS_API_URL}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
          body: JSON.stringify({ name: equipe.nome_cliente, email: profile.email, cpfCnpj: profile.cpf, externalReference: equipe.id })
       });
       const newCustomer = await newCustomerRes.json();
       if (!newCustomer.id) {
           // Tenta buscar se já existe (caso erro seja de duplicação)
           const searchRes = await fetch(`${ASAAS_API_URL}/customers?cpfCnpj=${profile.cpf}`, { headers: { 'access_token': asaasApiKey } });
           const searchData = await searchRes.json();
           if (searchData.data?.[0]?.id) asaasCustomerId = searchData.data[0].id;
           else throw new Error('Erro ao criar cliente Asaas');
       } else {
           asaasCustomerId = newCustomer.id;
       }
       await supabaseClient.from('equipes').update({ asaas_customer_id: asaasCustomerId }).eq('id', equipe.id);
    }

    // 2. Criar Transação Pendente
    const { data: transacao, error: txError } = await supabaseClient
      .from('transacoes')
      .insert({
        equipe_id: equipe.id,
        tipo: 'compra_creditos',
        valor: amount,
        status: 'pendente',
        descricao: `Compra de ${credits} créditos`,
        metadata: { creditos: credits }
      })
      .select()
      .single();

    if (txError) throw new Error(txError.message);

    // 3. Criar Cobrança Genérica (Permite PIX e Cartão na tela do Asaas)
    const paymentBody = {
      customer: asaasCustomerId,
      billingType: 'UNDEFINED', // Deixa o cliente escolher na tela do Asaas
      value: amount,
      dueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0], // Amanhã
      description: `Recarga de ${credits} créditos AdvAI`,
      externalReference: `credits_${transacao.id}`
    };

    const paymentRes = await fetch(`${ASAAS_API_URL}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
      body: JSON.stringify(paymentBody)
    });

    const paymentData = await paymentRes.json();
    if (!paymentRes.ok) throw new Error(paymentData.errors?.[0]?.description || 'Erro Asaas');

    // 4. Retornar URL da Fatura (Checkout)
    return new Response(JSON.stringify({ 
        success: true, 
        invoiceUrl: paymentData.invoiceUrl, // <--- O PULO DO GATO
        paymentId: paymentData.id
    }), { headers: corsHeaders });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { headers: corsHeaders, status: 500 });
  }
});

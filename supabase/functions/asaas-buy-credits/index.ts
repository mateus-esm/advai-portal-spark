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
    
    // Cliente Auth (para verificar quem está chamando)
    const supabaseAuth = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    // Cliente Admin (para inserir transação e atualizar cliente sem restrição RLS)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) throw new Error('Unauthorized');

    const { amount, paymentMethod, credits, creditCardToken } = await req.json();

    // Busca dados do perfil
    const { data: profile } = await supabaseAuth.from('profiles').select('equipe_id, nome_completo, email, cpf').eq('user_id', user.id).single();
    if (!profile?.cpf) throw new Error('CPF obrigatório no perfil.');

    const { data: equipe } = await supabaseAuth.from('equipes').select('id, nome_cliente, asaas_customer_id').eq('id', profile.equipe_id).single();

    // 1. Garantir Cliente no Asaas
    let asaasCustomerId = equipe.asaas_customer_id;
    if (!asaasCustomerId) {
       console.log('[Asaas Buy] Criando cliente no Asaas...');
       const newCustomerRes = await fetch(`${ASAAS_API_URL}/customers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
          body: JSON.stringify({ name: equipe.nome_cliente, email: profile.email, cpfCnpj: profile.cpf })
       });
       const newCustomer = await newCustomerRes.json();
       if (newCustomer.id) {
           asaasCustomerId = newCustomer.id;
           // Salva o ID do cliente usando o admin client
           await supabaseAdmin.from('equipes').update({ asaas_customer_id: asaasCustomerId }).eq('id', equipe.id);
       } else {
           throw new Error(`Falha ao criar cliente no Asaas: ${JSON.stringify(newCustomer)}`);
       }
    }

    // 2. CRIAR TRANSAÇÃO PENDENTE (CRÍTICO PARA O WEBHOOK)
    // Usamos o Service Role Key para garantir a inserção
    console.log('[Asaas Buy] Criando transação pendente...');
    const { data: transacao, error: txError } = await supabaseAdmin
      .from('transacoes')
      .insert({
        equipe_id: equipe.id,
        tipo: 'compra_creditos',
        valor: amount,
        status: 'pendente',
        descricao: `Compra de ${credits} créditos AdvAI`,
        metadata: { creditos: credits } // O Webhook lerá isso para liberar os créditos
      })
      .select()
      .single();

    if (txError) throw new Error(`Erro ao criar registro de transação: ${txError.message}`);

    // 3. CRIAR COBRANÇA NO ASAAS
    const billingType = paymentMethod === 'PIX' ? 'PIX' : 'CREDIT_CARD';
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 1); // Vence amanhã

    const paymentBody: any = {
      customer: asaasCustomerId,
      billingType: billingType,
      value: amount,
      dueDate: dueDate.toISOString().split('T')[0],
      description: `Recarga de ${credits} créditos AdvAI`,
      externalReference: `credits_${transacao.id}`, // <--- VÍNCULO IMPORTANTE
    };

    if (billingType === 'CREDIT_CARD' && creditCardToken) {
        paymentBody.creditCardToken = creditCardToken;
    }

    console.log('[Asaas Buy] Enviando para Asaas...');
    const paymentRes = await fetch(`${ASAAS_API_URL}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'access_token': asaasApiKey },
      body: JSON.stringify(paymentBody)
    });

    const paymentData = await paymentRes.json();

    if (!paymentRes.ok) {
        // Se falhar no Asaas, marca como falha no banco para não ficar pendente eternamente
        await supabaseAdmin.from('transacoes').update({ status: 'falha' }).eq('id', transacao.id);
        throw new Error(paymentData.errors?.[0]?.description || 'Erro no pagamento Asaas');
    }

    // Retorno para o Frontend
    const response: any = {
      success: true,
      paymentId: paymentData.id,
      invoiceUrl: paymentData.invoiceUrl,
      transactionId: transacao.id
    };

    if (billingType === 'PIX') {
       const pixRes = await fetch(`${ASAAS_API_URL}/payments/${paymentData.id}/pixQrCode`, {
         headers: { 'access_token': asaasApiKey }
       });
       const pixJson = await pixRes.json();
       response.pixQrCode = pixJson.encodedImage;
       response.pixCopyPaste = pixJson.payload;
    }

    return new Response(JSON.stringify(response), { headers: corsHeaders });

  } catch (error: any) {
    console.error('[Asaas Buy Error]', error);
    return new Response(JSON.stringify({ error: error.message }), { headers: corsHeaders, status: 500 });
  }
});

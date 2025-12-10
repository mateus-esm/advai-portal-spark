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
    // CORREÇÃO: Validação explícita para o TypeScript
    if (!asaasApiKey) {
      throw new Error('ASAAS_API_KEY not configured');
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const logs: string[] = [];
    const log = (msg: string) => { console.log(msg); logs.push(msg); };

    log("Iniciando sincronização Asaas -> Supabase...");

    log("Buscando clientes no Asaas...");
    const customersRes = await fetch(`${ASAAS_API_URL}/customers?limit=100`, {
      headers: { 'access_token': asaasApiKey }
    });
    
    if (!customersRes.ok) throw new Error("Erro ao buscar clientes Asaas");
    const customersData = await customersRes.json();
    const asaasCustomers = customersData.data;
    
    log(`${asaasCustomers.length} clientes encontrados no Asaas.`);

    for (const cus of asaasCustomers) {
        let { data: profile } = await supabaseClient
            .from('profiles')
            .select('equipe_id, email, cpf')
            .eq('email', cus.email)
            .maybeSingle();

        if (!profile && cus.cpfCnpj) {
            const cpfClean = cus.cpfCnpj.replace(/\D/g, '');
            const { data: profileCpf } = await supabaseClient
                .from('profiles')
                .select('equipe_id, email, cpf')
                .eq('cpf', cpfClean)
                .maybeSingle();
            profile = profileCpf;
        }

        if (profile && profile.equipe_id) {
            log(`MATCH: ${cus.name} (${cus.email}) [ID: ${cus.id}] -> Equipe ${profile.equipe_id}`);

            await supabaseClient
                .from('equipes')
                .update({ asaas_customer_id: cus.id })
                .eq('id', profile.equipe_id);

            const subRes = await fetch(`${ASAAS_API_URL}/subscriptions?customer=${cus.id}&status=ACTIVE`, {
                headers: { 'access_token': asaasApiKey }
            });
            const subData = await subRes.json();
            
            if (subData.data && subData.data.length > 0) {
                const sub = subData.data[0]; 
                log(`  > Assinatura encontrada: ${sub.id} (Prox: ${sub.nextDueDate})`);

                await supabaseClient
                    .from('equipes')
                    .update({ 
                        asaas_subscription_id: sub.id,
                        subscription_status: 'active',
                        next_due_date: sub.nextDueDate
                    })
                    .eq('id', profile.equipe_id);
            } else {
                log(`  > Nenhuma assinatura ativa encontrada.`);
            }

        } else {
            log(`SKIP: Cliente Asaas ${cus.name} (${cus.email}) não encontrado no Supabase.`);
        }
    }

    return new Response(JSON.stringify({ success: true, logs }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { headers: corsHeaders, status: 500 });
  }
});

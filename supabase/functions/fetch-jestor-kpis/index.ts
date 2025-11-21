import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization')!;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabaseClient.auth.getUser(token);

    if (!user) throw new Error('Unauthorized');

    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('equipe_id')
      .eq('user_id', user.id)
      .single();

    if (!profile) throw new Error('Profile not found');

    const { data: equipe } = await supabaseClient
      .from('equipes')
      .select('jestor_api_token')
      .eq('id', profile.equipe_id)
      .single();

    if (!equipe?.jestor_api_token) {
      return new Response(
        JSON.stringify({ error: 'Jestor API token not configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    const jestorToken = equipe.jestor_api_token;
    
    // Parse request body for custom date range
    let requestBody: any = {};
    try {
      requestBody = await req.json();
    } catch {
      // If no body, use current month
    }
    
    const targetMonth = requestBody.month ? parseInt(requestBody.month) : new Date().getMonth() + 1;
    const targetYear = requestBody.year ? parseInt(requestBody.year) : new Date().getFullYear();
    
    const firstDay = new Date(targetYear, targetMonth - 1, 1);
    const lastDay = new Date(targetYear, targetMonth, 0);
    const periodo = `${targetYear}-${targetMonth.toString().padStart(2, '0')}`;

    console.log(`[Jestor] Buscando dados para o período: ${periodo}`);

    // Buscar TODOS os leads da tabela - sem filtros de data inicialmente
    console.log('[Jestor] Buscando TODOS os registros da tabela o_apnte00i6bwtdfd2rjc...');
    
    const leadsResponse = await fetch('https://mateussmaia.api.jestor.com/object/list', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jestorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        object_type: 'o_apnte00i6bwtdfd2rjc',
        fields: ['*'],
        limit: 10000 // Limite alto para garantir que pegamos todos
      }),
    });

    if (!leadsResponse.ok) {
      const errText = await leadsResponse.text();
      console.error("[Jestor] Erro API:", errText);
      throw new Error(`Failed to fetch Jestor data: ${leadsResponse.status}`);
    }

    const leadsData = await leadsResponse.json();
    console.log("[Jestor] Resposta da API:", JSON.stringify(leadsData).substring(0, 500));

    let allLeads: any[] = [];
    
    if (Array.isArray(leadsData.data)) {
      allLeads = leadsData.data;
    } else if (leadsData.data && Array.isArray(leadsData.data.items)) {
      allLeads = leadsData.data.items;
    } else if (Array.isArray(leadsData)) {
      allLeads = leadsData;
    } else {
      console.error("[Jestor] ERRO: Estrutura inesperada!", leadsData);
      allLeads = [];
    }

    const leads = allLeads;

    console.log(`[Jestor] Total de TODOS os registros na tabela: ${leads.length}`);
    console.log(`[Jestor] Período de filtro: ${firstDay.toISOString()} até ${lastDay.toISOString()}`);

    // Filtra leads criados no mês atual
    const currentMonthLeads = leads.filter((lead: any) => {
      if (!lead.criado_em) return false;
      const createdDate = new Date(lead.criado_em);
      return createdDate >= firstDay && createdDate <= lastDay;
    });

    const leadsAtendidos = currentMonthLeads.length;
    console.log(`[Jestor] Leads no período ${periodo}: ${leadsAtendidos}`);

    // Reuniões: APENAS onde reuniao_agendada === true
    const reunioesAgendadas = currentMonthLeads.filter((lead: any) => {
      return lead.reuniao_agendada === true || lead.reuniao_agendada === 'true';
    }).length;
    
    console.log(`[Jestor] Reuniões agendadas (checkbox=true): ${reunioesAgendadas}`);

    // Negócios fechados: status contém "ganho"
    const negociosFechados = currentMonthLeads.filter((lead: any) => {
      const status = String(lead.status || '').toLowerCase();
      return status.includes('ganho');
    }).length;

    console.log(`[Jestor] Negócios fechados (status Ganho): ${negociosFechados}`);

    // Valor total dos negócios fechados
    const valorTotalNegocios = currentMonthLeads
      .filter((lead: any) => {
        const status = String(lead.status || '').toLowerCase();
        return status.includes('ganho');
      })
      .reduce((sum: number, lead: any) => sum + (parseFloat(lead.valor_da_proposta) || 0), 0);

    console.log(`[Jestor] Valor total dos negócios: R$ ${valorTotalNegocios}`);

    const taxaConversaoReuniao = leadsAtendidos > 0 ? ((reunioesAgendadas / leadsAtendidos) * 100).toFixed(1) : '0.0';
    const taxaConversaoNegocio = reunioesAgendadas > 0 ? ((negociosFechados / reunioesAgendadas) * 100).toFixed(1) : '0.0';

    await supabaseClient.from('kpis_dashboard').upsert({
      equipe_id: profile.equipe_id,
      leads_atendidos: leadsAtendidos,
      reunioes_agendadas: reunioesAgendadas,
      negocios_fechados: negociosFechados,
      valor_total_negocios: valorTotalNegocios,
      periodo: periodo,
    }, { onConflict: 'equipe_id,periodo', ignoreDuplicates: false });

    return new Response(JSON.stringify({
      leadsAtendidos, reunioesAgendadas, negociosFechados, valorTotalNegocios,
      taxaConversaoReuniao, taxaConversaoNegocio, periodo
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[Jestor] Erro Fatal:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});


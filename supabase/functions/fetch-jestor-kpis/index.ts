// supabase/functions/fetch-jestor-kpis/index.ts
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
    
    let requestBody: any = {};
    try {
      requestBody = await req.json();
    } catch { }
    
    // Data alvo (filtro do dashboard)
    const targetMonth = requestBody.month ? parseInt(requestBody.month) : new Date().getMonth() + 1;
    const targetYear = requestBody.year ? parseInt(requestBody.year) : new Date().getFullYear();
    
    // Intervalo de datas para filtrar a CRIAÇÃO do lead
    const firstDay = new Date(targetYear, targetMonth - 1, 1);
    const lastDay = new Date(targetYear, targetMonth, 0, 23, 59, 59);
    const periodo = `${targetYear}-${targetMonth.toString().padStart(2, '0')}`;

    console.log(`[Jestor] Buscando dados para coorte: ${periodo}`);

    // Buscar TODOS os leads (sem filtro na API para garantir que pegamos tudo e filtramos localmente)
    const leadsResponse = await fetch('https://mateussmaia.api.jestor.com/object/list', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jestorToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        object_type: 'o_apnte00i6bwtdfd2rjc',
        fields: ['*'],
        limit: 10000 
      }),
    });

    if (!leadsResponse.ok) {
      throw new Error(`Failed to fetch Jestor data: ${leadsResponse.status}`);
    }

    const leadsData = await leadsResponse.json();
    let allLeads: any[] = [];
    
    if (Array.isArray(leadsData.data)) {
      allLeads = leadsData.data;
    } else if (leadsData.data && Array.isArray(leadsData.data.items)) {
      allLeads = leadsData.data.items;
    } else if (Array.isArray(leadsData)) {
      allLeads = leadsData;
    }

    // Função Robustez de Data (DD/MM/YYYY ou ISO)
    const parseDate = (dateStr: any) => {
      if (!dateStr) return null;
      const str = String(dateStr).trim();
      
      // Tenta formato ISO direto
      let date = new Date(str);
      if (!isNaN(date.getTime())) return date;

      // Tenta formato BR (DD/MM/YYYY)
      if (str.includes('/')) {
        const parts = str.split('/'); // assumindo dia/mês/ano
        if (parts.length === 3) {
           // Mês no JS começa em 0
           return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
        }
      }
      return null;
    };

    // 1. FILTRAR LEADS DO PERÍODO (COORTE)
    // Apenas leads que nasceram neste mês entram na conta
    const leadsDaCoorte = allLeads.filter((lead: any) => {
      const createdDate = parseDate(lead.criado_em); // usando o campo correto do seu Jestor
      if (!createdDate) return false;
      return createdDate >= firstDay && createdDate <= lastDay;
    });

    const leadsAtendidos = leadsDaCoorte.length;
    console.log(`[Jestor] Leads criados em ${periodo}: ${leadsAtendidos}`);

    // 2. CALCULAR MÉTRICAS DENTRO DA COORTE
    // Destes leads criados no mês, quantos agendaram ou fecharam?
    
    const reunioesAgendadas = leadsDaCoorte.filter((lead: any) => {
      // Verifica booleano true, string "true" ou "1"
      return lead.reuniao_agendada === true || String(lead.reuniao_agendada) === 'true' || lead.reuniao_agendada === 1;
    }).length;

    const negociosFechados = leadsDaCoorte.filter((lead: any) => {
      const status = String(lead.status || '').toLowerCase();
      return status.includes('ganho') || status.includes('fechado') || status.includes('contrato');
    }).length;

    const valorTotalNegocios = leadsDaCoorte
      .filter((lead: any) => {
        const status = String(lead.status || '').toLowerCase();
        return status.includes('ganho') || status.includes('fechado') || status.includes('contrato');
      })
      .reduce((sum: number, lead: any) => {
        // Limpa formatação de moeda (R$ 1.000,00 -> 1000.00) se necessário
        let valor = lead.valor_da_proposta;
        if (typeof valor === 'string') {
            valor = parseFloat(valor.replace('R$', '').replace('.', '').replace(',', '.').trim());
        }
        return sum + (Number(valor) || 0);
      }, 0);

    // Salvar no banco para cache/histórico
    await supabaseClient.from('kpis_dashboard').upsert({
      equipe_id: profile.equipe_id,
      leads_atendidos: leadsAtendidos,
      reunioes_agendadas: reunioesAgendadas,
      negocios_fechados: negociosFechados,
      valor_total_negocios: valorTotalNegocios,
      periodo: periodo,
    }, { onConflict: 'equipe_id,periodo', ignoreDuplicates: false });

    return new Response(JSON.stringify({
      leadsAtendidos, 
      reunioesAgendadas, 
      negociosFechados, 
      valorTotalNegocios,
      taxaConversaoReuniao: leadsAtendidos > 0 ? ((reunioesAgendadas / leadsAtendidos) * 100).toFixed(1) : '0.0',
      taxaConversaoNegocio: reunioesAgendadas > 0 ? ((negociosFechados / reunioesAgendadas) * 100).toFixed(1) : '0.0',
      periodo
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[Jestor] Erro:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

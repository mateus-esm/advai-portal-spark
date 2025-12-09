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

    const { data: profile } = await supabaseClient.from('profiles').select('equipe_id').eq('user_id', user.id).single();
    if (!profile) throw new Error('Profile not found');

    const { data: equipe } = await supabaseClient.from('equipes').select('jestor_api_token').eq('id', profile.equipe_id).single();
    if (!equipe?.jestor_api_token) throw new Error('Jestor API token not configured');

    // 1. Receber Mês/Ano do Frontend (ou usar atual)
    let reqBody = {};
    try { reqBody = await req.json(); } catch {}
    
    const now = new Date();
    const targetMonth = reqBody.month ? parseInt(reqBody.month) : now.getMonth() + 1;
    const targetYear = reqBody.year ? parseInt(reqBody.year) : now.getFullYear();
    
    // Definir intervalo exato do mês (00:00:00 dia 1 até 23:59:59 dia 31)
    const firstDay = new Date(targetYear, targetMonth - 1, 1);
    const lastDay = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999); // Último dia do mês
    const periodo = `${targetYear}-${targetMonth.toString().padStart(2, '0')}`;

    console.log(`[Jestor] Buscando Coorte: ${periodo} (De ${firstDay.toISOString()} até ${lastDay.toISOString()})`);

    // 2. Buscar TODOS os leads do Jestor (Paginação pode ser necessária se passar de 10k)
    const leadsResponse = await fetch('https://mateussmaia.api.jestor.com/object/list', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${equipe.jestor_api_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        object_type: 'o_apnte00i6bwtdfd2rjc',
        fields: ['*'],
        limit: 10000 // Limite de segurança
      }),
    });

    if (!leadsResponse.ok) throw new Error('Erro na API Jestor');
    const leadsData = await leadsResponse.json();
    
    let allLeads: any[] = [];
    if (Array.isArray(leadsData.data)) allLeads = leadsData.data;
    else if (leadsData.data?.items) allLeads = leadsData.data.items;

    // Helper robusto para datas (ISO e BR)
    const parseDate = (dateStr: any) => {
      if (!dateStr) return null;
      const str = String(dateStr).trim();
      // ISO (YYYY-MM-DD...)
      if (str.includes('-')) return new Date(str);
      // BR (DD/MM/YYYY)
      if (str.includes('/')) {
        const [d, m, y] = str.split('/');
        return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
      }
      return null;
    };

    // 3. FILTRAGEM DE COORTE
    // Apenas leads nascidos no mês alvo
    const leadsDaCoorte = allLeads.filter((lead: any) => {
      const createdDate = parseDate(lead.criado_em);
      if (!createdDate || isNaN(createdDate.getTime())) return false;
      return createdDate >= firstDay && createdDate <= lastDay;
    });

    // 4. CÁLCULO DE MÉTRICAS (Baseado APENAS na coorte filtrada)
    const leadsAtendidos = leadsDaCoorte.length;

    // Checkbox marcado (true/1/"true") DENTRO desta coorte
    const reunioesAgendadas = leadsDaCoorte.filter((lead: any) => {
      const val = lead.reuniao_agendada;
      return val === true || val === 'true' || val === 1;
    }).length;

    // Negócios ganhos DENTRO desta coorte
    const negociosFechados = leadsDaCoorte.filter((lead: any) => {
      const status = String(lead.status || '').toLowerCase();
      return status.includes('ganho') || status.includes('fechado') || status.includes('contrato');
    }).length;

    // Valor monetário DENTRO desta coorte
    const valorTotalNegocios = leadsDaCoorte
      .filter((lead: any) => {
        const status = String(lead.status || '').toLowerCase();
        return status.includes('ganho') || status.includes('fechado') || status.includes('contrato');
      })
      .reduce((sum: number, lead: any) => {
        let v = lead.valor_da_proposta;
        if (typeof v === 'string') {
            // Limpa R$, pontos de milhar e troca virgula decimal por ponto
            v = parseFloat(v.replace(/[^\d,.-]/g, '').replace('.', '').replace(',', '.'));
        }
        return sum + (Number(v) || 0);
      }, 0);

    console.log(`[Jestor] KPI Final ${periodo}: Leads=${leadsAtendidos}, Reuniões=${reunioesAgendadas}`);

    // Salvar Cache
    await supabaseClient.from('kpis_dashboard').upsert({
      equipe_id: profile.equipe_id,
      leads_atendidos: leadsAtendidos,
      reunioes_agendadas: reunioesAgendadas,
      negocios_fechados: negociosFechados,
      valor_total_negocios: valorTotalNegocios,
      periodo: periodo,
    }, { onConflict: 'equipe_id,periodo' });

    return new Response(JSON.stringify({
      leadsAtendidos, reunioesAgendadas, negociosFechados, valorTotalNegocios, periodo
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), { headers: corsHeaders, status: 500 });
  }
});

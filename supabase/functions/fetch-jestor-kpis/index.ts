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

    const { data: profile } = await supabaseClient.from('profiles').select('equipe_id').eq('user_id', user.id).single();
    if (!profile) throw new Error('Profile not found');

    const { data: equipe } = await supabaseClient.from('equipes').select('jestor_api_token').eq('id', profile.equipe_id).single();
    if (!equipe?.jestor_api_token) throw new Error('Jestor API token not configured');

    console.log('[Jestor Sync] Iniciando sincronização completa...');

    const jestorUrl = 'https://mateussmaia.api.jestor.com/object/list';
    let allLeads: any[] = [];
    let offset = 0;
    const batchSize = 20; // Jestor retorna ~20 por vez
    const maxIterations = 100; // Proteção: máximo 2000 leads
    let iterations = 0;

    // Helper para delay entre requests (evita 429)
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Função para fazer request com retry em caso de 429
    const fetchWithRetry = async (body: any, retries = 3): Promise<any[]> => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            const response = await fetch(jestorUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${equipe.jestor_api_token}`
                },
                body: JSON.stringify(body)
            });

            if (response.status === 429) {
                console.log(`[Jestor Sync] Rate limit (429), aguardando ${attempt * 2}s...`);
                await delay(attempt * 2000); // Backoff exponencial: 2s, 4s, 6s
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[Jestor Sync] API Error: ${response.status} - ${errorText}`);
                throw new Error(`Jestor API Error: ${response.status}`);
            }
            
            const json = await response.json();
            
            if (Array.isArray(json.data)) return json.data;
            if (json.data?.items && Array.isArray(json.data.items)) return json.data.items;
            if (json.items && Array.isArray(json.items)) return json.items;
            if (Array.isArray(json)) return json;
            return [];
        }
        throw new Error('Jestor API: Máximo de tentativas excedido (429)');
    };

    // --- 1. LOOP DE PAGINAÇÃO COM DELAY E RETRY ---
    while (iterations < maxIterations) {
        iterations++;
        console.log(`[Jestor Sync] Batch ${iterations}, offset=${offset}...`);
        
        // Delay entre requests para evitar 429 (1.5s)
        if (iterations > 1) {
            await delay(1500);
        }
        
        const bodyJestor = {
            object_type: 'o_apnte00i6bwtdfd2rjc',
            fields: ['id_jestor', 'criado_em', 'reuniao_agendada', 'status', 'valor_da_proposta'],
            limit: batchSize,
            offset: offset,
            sort: 'id_jestor',
            direction: 'asc'
        };

        const pageData = await fetchWithRetry(bodyJestor);

        console.log(`[Jestor Sync] Batch ${iterations}: ${pageData.length} registros`);

        if (pageData.length === 0) {
            console.log('[Jestor Sync] Nenhum registro, finalizando.');
            break;
        }

        allLeads = [...allLeads, ...pageData];
        offset += pageData.length;

        // Se veio menos que o batch size, é o último
        if (pageData.length < batchSize) {
            console.log(`[Jestor Sync] Último batch (${pageData.length} < ${batchSize}), finalizando.`);
            break;
        }
    }

    console.log(`[Jestor Sync] TOTAL FINAL: ${allLeads.length} leads em ${iterations} batches`);

    // --- 2. PROCESSAMENTO E AGREGAÇÃO (Lógica de Bucket Mensal) ---
    const monthlyStats: Record<string, any> = {};

    // Helper robusto de data (BR e ISO)
    const parseDate = (val: any) => {
        if (!val) return null;
        const s = String(val).trim();
        // ISO
        if (s.includes('T') || s.includes('-')) return new Date(s);
        // BR (DD/MM/YYYY)
        if (s.includes('/')) {
            const parts = s.split(' ')[0].split('/'); // Remove hora se houver
            if (parts.length === 3) {
                return new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
            }
        }
        return null;
    };

    allLeads.forEach((lead: any) => {
        const date = parseDate(lead.criado_em);
        if (!date || isNaN(date.getTime())) return;

        // Chave do mês: "2025-11"
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        if (!monthlyStats[monthKey]) {
            monthlyStats[monthKey] = {
                leads_atendidos: 0,
                reunioes_agendadas: 0,
                negocios_fechados: 0,
                valor_total_negocios: 0
            };
        }

        const stats = monthlyStats[monthKey];
        stats.leads_atendidos++;

        // Reunião (Checkbox)
        const r = lead.reuniao_agendada;
        if (r === true || r === 'true' || r === 1) {
            stats.reunioes_agendadas++;
        }

        // Negócio Fechado (Status)
        const status = String(lead.status || '').toLowerCase();
        if (status.includes('ganho') || status.includes('fechado') || status.includes('contrato')) {
            stats.negocios_fechados++;
            
            // Valor (Tratamento BR: 1.200,50 -> 1200.50)
            let v = lead.valor_da_proposta;
            if (typeof v === 'string') {
                // Remove tudo que não é numero, ponto, virgula ou traço
                // Remove pontos de milhar
                // Troca virgula decimal por ponto
                v = parseFloat(v.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
            }
            stats.valor_total_negocios += (Number(v) || 0);
        }
    });

    // --- 3. UPSERT EM LOTE NO SUPABASE ---
    const recordsToUpsert = Object.entries(monthlyStats).map(([periodo, stats]) => ({
        equipe_id: profile.equipe_id,
        periodo: periodo,
        ...stats,
        updated_at: new Date().toISOString()
    }));

    if (recordsToUpsert.length > 0) {
        const { error } = await supabaseClient
            .from('kpis_dashboard')
            .upsert(recordsToUpsert, { onConflict: 'equipe_id,periodo' });
        
        if (error) console.error('Erro ao salvar no banco:', error);
    }

    // Ordenar por data (mais recente primeiro) para o front
    const sortedData = recordsToUpsert.sort((a, b) => b.periodo.localeCompare(a.periodo));

    return new Response(JSON.stringify(sortedData), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (error: any) {
    console.error('[Jestor Sync] Erro Fatal:', error);
    return new Response(JSON.stringify({ error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});

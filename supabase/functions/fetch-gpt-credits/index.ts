// supabase/functions/fetch-gpt-credits/index.ts
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

    // Parse URL params para permitir busca de histórico
    const url = new URL(req.url);
    const queryMonth = url.searchParams.get('month');
    const queryYear = url.searchParams.get('year');

    const now = new Date();
    const year = queryYear ? parseInt(queryYear) : now.getFullYear();
    const month = queryMonth ? parseInt(queryMonth) : now.getMonth() + 1;
    const periodo = `${year}-${month.toString().padStart(2, '0')}`;

    const { data: profile } = await supabaseClient.from('profiles').select('equipe_id').eq('user_id', user.id).single();
    if (!profile) throw new Error('Profile not found');

    const { data: equipe } = await supabaseClient
      .from('equipes')
      .select('gpt_maker_agent_id, limite_creditos, creditos_avulsos')
      .eq('id', profile.equipe_id)
      .single();

    if (!equipe?.gpt_maker_agent_id) {
      return new Response(
        JSON.stringify({ error: 'GPT Maker Agent ID not configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    const gptMakerToken = Deno.env.get('GPT_MAKER_API_TOKEN');
    
    // Busca na API do GPT Maker
    const spentUrl = `https://api.gptmaker.ai/v2/agent/${equipe.gpt_maker_agent_id}/credits-spent?year=${year}&month=${month}`;
    const spentRes = await fetch(spentUrl, { 
      headers: { 'Authorization': `Bearer ${gptMakerToken}`, 'Content-Type': 'application/json' } 
    });

    if (!spentRes.ok) throw new Error('Failed to fetch from GPT Maker');
    const spentData = await spentRes.json();
    const creditsSpent = spentData.total || 0;

    const planLimit = equipe.limite_creditos || 1000;
    const extraCredits = equipe.creditos_avulsos || 0;
    const totalCredits = planLimit + extraCredits;
    const creditsBalance = totalCredits - creditsSpent;

    // Salva histórico
    await supabaseClient.from('consumo_creditos').upsert({
      equipe_id: profile.equipe_id, 
      creditos_utilizados: creditsSpent, 
      periodo, 
      metadata: spentData
    }, { onConflict: 'equipe_id,periodo', ignoreDuplicates: false });

    return new Response(JSON.stringify({
      creditsSpent,
      creditsBalance,
      totalCredits,
      planLimit,
      extraCredits,
      periodo
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

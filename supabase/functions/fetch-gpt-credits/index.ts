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

    const { data: equipe } = await supabaseClient.from('equipes').select('gpt_maker_agent_id, workspace_id').eq('id', profile.equipe_id).single();

    if (!equipe?.gpt_maker_agent_id || !equipe?.workspace_id) {
      return new Response(
        JSON.stringify({ error: 'GPT Maker configuration incomplete' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    const gptMakerToken = Deno.env.get('GPT_MAKER_API_TOKEN');
    if (!gptMakerToken) throw new Error('GPT Maker API token not configured');

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const spentRes = await fetch(`https://api.gptmaker.ai/v2/agent/${equipe.gpt_maker_agent_id}/credits-spent?year=${year}&month=${month}`, {
      headers: { 'Authorization': `Bearer ${gptMakerToken}`, 'Content-Type': 'application/json' }
    });
    
    const balanceRes = await fetch(`https://api.gptmaker.ai/v2/workspace/${equipe.workspace_id}/credits`, {
      headers: { 'Authorization': `Bearer ${gptMakerToken}`, 'Content-Type': 'application/json' }
    });

    if (!spentRes.ok || !balanceRes.ok) throw new Error('GPT Maker API error');

    const spentData = await spentRes.json();
    const balanceData = await balanceRes.json();
    const periodo = `${year}-${month.toString().padStart(2, '0')}`;
    const creditsSpent = spentData.total_credits_spent || 0;

    await supabaseClient.from('consumo_creditos').upsert({
      equipe_id: profile.equipe_id, creditos_utilizados: creditsSpent, periodo, metadata: spentData
    }, { onConflict: 'equipe_id,periodo', ignoreDuplicates: false });

    return new Response(JSON.stringify({
      creditsSpent, creditsBalance: balanceData.balance || 0, periodo
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

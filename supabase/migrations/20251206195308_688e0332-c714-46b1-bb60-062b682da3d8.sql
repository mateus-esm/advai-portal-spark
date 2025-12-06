-- Zero out extra credits for Walter Inglez team (fixing incorrect accumulation)
UPDATE equipes SET creditos_avulsos = 0 WHERE id = 'f4febde4-6ae3-474e-aa41-2c2fbffccb72';
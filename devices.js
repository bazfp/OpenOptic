/* Scanners OpenOptic knows, by USB product id and device revision (bcdDevice). A "supported" revision is
   driven. A recognised one is identified and refused with an explanation, so no motor or lamp command
   reaches hardware whose protocol has not been validated. No DOM; tested in tests/devices.test.cjs. */
(() => {
  const DEVICES={
    0x0C3B:{name:'Plustek OpticFilm 7600i',revisions:{
      0x0400:{chip:'GL843',supported:true},
      0x0605:{chip:'GL845',supported:false}}},
    0x130C:{name:'Plustek OpticFilm 8100',revisions:{
      // Experimental: boot, homing, the 900 ppi preview and the 3600 and 7200 ppi passes were proven on hardware (tools/hwtest_8100.cjs)
      // with the recorded exposure and software flat-field, and multi-exposure at 3600 ppi; live calibration is not built (the 8100 has no infrared channel).
      0x0605:{chip:'GL845',supported:true,driver:'gl845',experimental:true}}},
  };
  const hex=(v,n)=>'0x'+v.toString(16).toUpperCase().padStart(n,'0');
  // Returns {ok, name, chip, message}; message explains a refusal.
  function check(pid,bcd){
    const d=DEVICES[pid];
    if(!d)return {ok:false,message:'Unknown scanner (USB product id '+hex(pid,4)+').'};
    const r=d.revisions[bcd];
    const rev=`bcdDevice ${bcd>>8}.${(bcd>>4)&15}${bcd&15}`;
    if(!r)return {ok:false,name:d.name,message:`This ${d.name} reports ${rev}, which OpenOptic has not seen. No commands were sent.`};
    if(r.supported)return {ok:true,name:d.name,chip:r.chip,driver:r.driver||'gl843',experimental:!!r.experimental};
    return {ok:false,name:d.name,chip:r.chip,message:r.reason
      ?`${d.name} (${r.chip}, ${rev}) recognised, but OpenOptic cannot scan with it yet: ${r.reason}. No motor or lamp commands were sent.`
      :`This scanner reports ${rev} (${r.chip}). The recorded profiles are for the 7600i v1 (4.00) only. No motor or lamp commands were sent.`};
  }
  globalThis.Devices={DEVICES,check,PIDS:Object.keys(DEVICES).map(Number)};
})();

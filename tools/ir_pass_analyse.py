#!/usr/bin/env python3
"""Analyse an iSRD (colour + infrared) capture after tools/capture_extract.py has written its frames.
Measures: IR-to-colour registration (on dust, sub-pixel), dye crosstalk into IR, defect coverage.
    python3 tools/capture_extract.py . ir.pcapng out/ir
    python3 tools/ir_pass_analyse.py out/ir [colour_frame=7] [ir_frame=15]
Needs numpy and scipy. Prints statistics only; never writes image data."""
import numpy as np, sys
from scipy import ndimage as nd
d=sys.argv[1]; cf=int(sys.argv[2]) if len(sys.argv)>2 else 7; irf=int(sys.argv[3]) if len(sys.argv)>3 else 15
P=5124; L=7058; sh=[0,24,48]
ld=lambda i:np.memmap(f'{d}/frame{i:02d}.bin',dtype='<u2',mode='r').reshape(L,P,3)
rgb,ir=ld(cf),ld(irf); y0,y1,x0,x1=400,L-400,300,P-300
# 1. registration on clear IR defects: mean dark-speck strength of the colour pass at IR defect pixels
for c,cn in [(0,'R'),(1,'G')]:
    I=ir[y0:y1,x0:x1,c].astype(np.float32); bg=nd.uniform_filter(nd.grey_closing(I,size=(15,15)),size=15)
    D=np.clip(1-I/np.maximum(bg,1),0,1)
    X=np.log(rgb[y0:y1,x0:x1,c].astype(np.float32)+64); T=nd.grey_closing(X,size=(15,15))-X
    m=D>0.25; ys,xs=np.nonzero(m); w=D[m]; S=np.zeros((11,11))
    for i,dy in enumerate(range(-5,6)):
        for j,dx in enumerate(range(-5,6)):
            yy=np.clip(ys+dy,0,T.shape[0]-1); xx=np.clip(xs+dx,0,T.shape[1]-1); S[i,j]=(T[yy,xx]*w).sum()/w.sum()
    i,j=np.unravel_index(S.argmax(),S.shape); i=min(max(i,1),9); j=min(max(j,1),9)
    fy=(S[i-1,j]-S[i+1,j])/(2*(S[i-1,j]-2*S[i,j]+S[i+1,j])); fx=(S[i,j-1]-S[i,j+1])/(2*(S[i,j-1]-2*S[i,j]+S[i,j+1]))
    print(f'registration ({cn}, {m.sum()} defect px): colour = IR shifted rows {i-5+fy:+.2f}, columns {j-5+fx:+.2f} (raw lines/columns)')
    if c==0: print(f'defect coverage: {(D>0.10).mean()*100:.3f} % of pixels >10 % darker than surroundings in IR')
# 2. dye crosstalk: log IR against log R/G/B in clean areas
ch=lambda a,c,dy=0:a[y0+sh[c]+dy:y1+sh[c]+dy:4,x0:x1:4,c].astype(np.float64)
IRc=ch(ir,0,2); bg=nd.uniform_filter(nd.grey_closing(IRc,size=7),7); clean=IRc>0.95*bg
A=np.c_[np.stack([np.log(ch(rgb,c)) for c in range(3)],-1)[clean],np.ones(clean.sum())]
coef,*_=np.linalg.lstsq(A,np.log(IRc[clean]),rcond=None)
print('crosstalk: log IR = %.3f logR %+.3f logG %+.3f logB %+.2f'%tuple(coef))

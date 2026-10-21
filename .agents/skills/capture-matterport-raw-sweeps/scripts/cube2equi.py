# usage: cube2equi.py <sweepdir> <outdir> [size]   (Matterport skybox/512 faces: 0=up,1..4 sides L->R,5=down)
import sys,re,glob,os,numpy as np,cv2
src,out=sys.argv[1:3]; H=int(sys.argv[3]) if len(sys.argv)>3 else 1024
W=2*H
j=(np.arange(W)+.5)/W*2*np.pi-np.pi; i=(np.arange(H)+.5)/H*np.pi
lon,th=np.meshgrid(j,i); lat=np.pi/2-th
x=np.cos(lat)*np.sin(lon); y=np.sin(lat); z=np.cos(lat)*np.cos(lon)
def face_map(a,b,c):  # a,b: coords on face (-1..1), c depth(>0)
    pass
res=np.zeros((H,W,3),np.uint8)
def put(mask,u,v,img):
    s=img.shape[0]
    mx=((u+1)/2*s-.5).astype(np.float32); my=((1-(v+1)/2)*s-.5).astype(np.float32)
    r=cv2.remap(img,mx,my,cv2.INTER_LINEAR)
    res[mask]=r[mask]
def sweeps():
    s=set()
    for f in glob.glob(src+'/*_512_000.jpg'): s.add(os.path.basename(f)[:32])
    return sorted(s)
os.makedirs(out,exist_ok=True)
for sid in sweeps():
    F=[cv2.imread(f'{src}/{sid}_512_{k:03d}.jpg') for k in range(6)]
    ax,ay,az=abs(x),abs(y),abs(z)
    m1=(az>=ax)&(az>=ay)&(z>0); m2=(ax>az)&(ax>=ay)&(x>0); m3=(az>=ax)&(az>=ay)&(z<0); m4=(ax>az)&(ax>=ay)&(x<0)
    mu=(ay>ax)&(ay>az)&(y>0); md=(ay>ax)&(ay>az)&(y<0)
    with np.errstate(all='ignore'):
        put(m1,x/z,y/z,F[1]); put(m2,-z/x,y/x,F[2]); put(m3,x/z,-y/z,F[3]); put(m4,-z/x,-y/x,F[4])
        put(mu,x/y,-z/y,F[0]); put(md,x/-y,z/-y,F[5])
    cv2.imwrite(f'{out}/{sid}.jpg',res,[cv2.IMWRITE_JPEG_QUALITY,92])
# post: fill the unscanned grey pole caps by push-pull from surrounding pixels
def fill(path):
    im=cv2.imread(path).astype(np.float32); m=(np.abs(im-128).max(2)<=2).astype(np.uint8)
    m=cv2.erode(m,np.ones((3,3)),iterations=1)  # only solid grey
    m=cv2.dilate(m,np.ones((5,5)),iterations=2).astype(bool)
    # pyramid fill
    w=(~m).astype(np.float32)[...,None]; levels=[(im*w,w)]
    while min(levels[-1][0].shape[:2])>4:
        a,b=levels[-1]; levels.append((cv2.pyrDown(a),cv2.pyrDown(b)[...,None] if cv2.pyrDown(b).ndim==2 else cv2.pyrDown(b)))
    cur=levels[-1][0]/np.maximum(levels[-1][1],1e-4)
    for a,b in reversed(levels[:-1]):
        up=cv2.resize(cur,(a.shape[1],a.shape[0]))
        bb=np.clip(b*4,0,1); own=a/np.maximum(b,1e-4)
        cur=own*bb+up*(1-bb)
    out=np.where(m[...,None],cur,im)
    cv2.imwrite(path,np.clip(out,0,255).astype(np.uint8),[cv2.IMWRITE_JPEG_QUALITY,92])
for f in glob.glob(out+'/*.jpg'): fill(f)

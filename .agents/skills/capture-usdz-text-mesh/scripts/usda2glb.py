# usage: usda2glb.py in.usda out.glb  -- static (default-value) conversion of a text USD mesh hierarchy to GLB
import sys, re, ast, numpy as np, trimesh
from trimesh.transformations import quaternion_matrix, translation_matrix
src, out = sys.argv[1:3]
lines = open(src).read().split('\n')
root = {'type':'root','name':'','children':[],'attrs':{}}
stack=[root]; pending=None; i=0; mats={}; inmeta=False
while i < len(lines):
    s = lines[i].strip(); i+=1
    if not s: continue
    m = re.match(r'(?:def|over)\s+(\w+)?\s*"([^"]+)"', s)
    if m:
        pending={'type':m.group(1),'name':m.group(2),'children':[],'attrs':{}}; continue
    if pending is not None and s != '{' and not re.match(r'(?:def|over)\s',s): continue
    if s == '{' :
        if pending: stack[-1]['children'].append(pending); stack.append(pending); pending=None
        continue
    if s == '}':
        if len(stack)>1: stack.pop()
        continue
    if pending is not None or len(stack)==1: continue
    if 'timeSamples' in s:
        if s.endswith('{'):
            while lines[i].strip()!='}': i+=1
            i+=1
        continue
    m = re.match(r'(?:uniform\s+)?([\w\[\]]+)\s+([\w:.]+)\s*=\s*(.*)$', s)
    if m and m.group(3)!='(' :
        stack[-1]['attrs'][m.group(2)] = m.group(3)
    elif s.startswith('rel material:binding'):
        stack[-1]['attrs']['binding']=s.split('<')[1].rstrip('>')
def val(t):
    t=t.strip()
    if t.endswith('('): t=t[:-1].strip()
    return np.array(ast.literal_eval(t.replace('-nan','0').replace('nan','0')),dtype=float)
def mat_of(p):
    M=np.eye(4); a=p['attrs']
    order=a.get('xformOpOrder','[]'); ops=ast.literal_eval(order)
    T=np.eye(4)
    # USD ops listed outermost-first applied to column vectors: M = op1 * op2 * ...
    for op in ops:
        if op not in a: continue
        v=val(a[op])
        if op=='xformOp:translate': X=translation_matrix(v)
        elif op=='xformOp:orient': X=quaternion_matrix(v)  # (w,x,y,z)
        elif op=='xformOp:scale': X=np.diag(list(v)+[1])
        elif op=='xformOp:transform': X=val(a[op]).reshape(4,4).T
        else: continue
        T=T@X
    return T
# materials
for sc in root['children'][0]['children']:
    if sc['name']=='Materials':
        for mt in sc['children']:
            col=[.6,.6,.6]; met=0; rough=.5
            for sh in mt['children']:
                if sh['name']=='surfaceShader':
                    a=sh['attrs']
                    if 'inputs:diffuseColor' in a:
                        try: col=list(val(a['inputs:diffuseColor']))
                        except Exception: pass
                    if 'inputs:metallic' in a:
                        try: met=float(a['inputs:metallic'])
                        except Exception: pass
                    if 'inputs:roughness' in a:
                        try: rough=float(a['inputs:roughness'])
                        except Exception: pass
            mats[mt['name']]=trimesh.visual.material.PBRMaterial(baseColorFactor=[*col,1],metallicFactor=met,roughnessFactor=rough,doubleSided=True)
scene=trimesh.Scene(); n=0
def walk(p,M):
    global n
    M=M@mat_of(p) if p['type'] in('Xform','Mesh') else M
    if p['type']=='Mesh' and 'points' in p['attrs']:
        a=p['attrs']; pts=val(a['points']).reshape(-1,3)
        cnt=val(a['faceVertexCounts']).astype(int); idx=val(a['faceVertexIndices']).astype(int)
        faces=[]; k=0
        for c in cnt:
            for j in range(1,c-1): faces.append([idx[k],idx[k+j],idx[k+j+1]])
            k+=c
        mesh=trimesh.Trimesh(pts,np.array(faces),process=False)
        b=a.get('binding','').split('/')[-1]
        if b in mats: mesh.visual=trimesh.visual.ColorVisuals(mesh,vertex_colors=(np.array(mats[b].baseColorFactor)[:3]**(1/2.2)*255).astype(np.uint8).tolist()*0+[[*(np.clip(np.array(mats[b].baseColorFactor[:3])**(1/2.2),0,1)*255).astype(np.uint8),255]]*len(pts))
        scene.add_geometry(mesh,node_name=f'm{n}',transform=M); n+=1
    for c in p['children']: walk(c,M)
def show(p,d=0):
    if d<4: print(" "*d,p["type"],p["name"],len(p["children"])); [show(c,d+1) for c in p["children"]]
geom=[c for c in root["children"][0]["children"] if c["name"]=="Geom"][0]
walk(geom,mat_of(root['children'][0]) if False else np.eye(4))
print('meshes',n,'bounds',scene.bounds)
scene.export(out)

import os, time, requests
from datetime import datetime
from msal import ConfidentialClientApplication

TENANT       = "e752f42c-b793-44a0-821a-1ce42bcf7ac3"
CLIENT_ID    = "e74475f7-95e5-4968-a21f-0b91b4834491"
CLIENT_SECRET = os.environ["AZURE_CLIENT_SECRET"]
USERNAME     = os.environ["PBI_USERNAME"]
PASSWORD     = os.environ["PBI_PASSWORD"]

WORKSPACE_ID = "234f9d81-3fd0-4618-9c73-70d9415096ff"
DATASET_ID   = "8d2bbc21-b203-4d2e-b468-fe4d8ddefef4"
SCOPES       = ["https://analysis.windows.net/powerbi/api/.default"]

def get_token():
    app = ConfidentialClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT}",
        client_credential=CLIENT_SECRET
    )
    result = app.acquire_token_by_username_password(USERNAME, PASSWORD, scopes=SCOPES)
    if "access_token" not in result:
        raise Exception(f"[ERRO] Autenticacao falhou: {result.get('error_description')}")
    print("[OK] Autenticado com sucesso.")
    return result["access_token"]

def refresh_dataset(token):
    url = f"https://api.powerbi.com/v1.0/myorg/groups/{WORKSPACE_ID}/datasets/{DATASET_ID}/refreshes"
    r = requests.post(url, headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 202:
        print("[OK] Atualizacao do dataset iniciada.")
    else:
        raise Exception(f"[ERRO] {r.status_code} {r.text}")

def wait_refresh(token, timeout=300):
    url = f"https://api.powerbi.com/v1.0/myorg/groups/{WORKSPACE_ID}/datasets/{DATASET_ID}/refreshes?$top=1"
    headers = {"Authorization": f"Bearer {token}"}
    print("Aguardando atualizacao", end="", flush=True)
    for _ in range(timeout // 10):
        time.sleep(10)
        status = requests.get(url, headers=headers).json()["value"][0]["status"]
        print(".", end="", flush=True)
        if status == "Completed":
            print("\n[OK] Dataset atualizado.")
            return
        if status == "Failed":
            raise Exception("\n[ERRO] Atualizacao falhou.")
    raise Exception("\n[ERRO] Timeout.")

def run():
    token = get_token()
    refresh_dataset(token)
    wait_refresh(token)
    print("Etapa 3 concluida.")

if __name__ == "__main__":
    run()

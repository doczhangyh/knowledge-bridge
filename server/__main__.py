"""启动：python -m server。"""
import sys
from .app import create_app
from .config import load_config


def main():
    try:
        config = load_config()
        with create_app(config) as app:
            print(f"\n  知桥 · Knowledge Bridge（Python）\n  http://127.0.0.1:{app.server_port}\n  模式：" +
                  ("本地演示（未调用真实模型）" if config["mode"] == "demo" else "真实模型"), flush=True)
            try:
                app.serve_forever()
            except KeyboardInterrupt:
                pass
    except (OSError, ValueError) as error:
        print("启动失败：" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

import os
import re
import json
import humanize
import matplotlib.pyplot as plt
import numpy as np


def load_benchmarks(benchmarks_dir):
    devices = {}
    for filename in os.listdir(benchmarks_dir):
        if not filename.endswith('.txt'):
            continue

        device_name = filename.replace('.txt', '')
        devices[device_name] = {}
        with open(os.path.join(benchmarks_dir, filename), encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        current_hashmode = None
        for line in lines:
            # Match Hashmode行（etc: Hashmode: 0 - MD5 or * Hash-Mode 0 (MD5)）
            m1 = re.match(r'Hashmode:\s*([\d]+)\s*-\s*(.+)', line)
            m2 = re.match(r'\* Hash-Mode\s*([\d]+)\s*\((.+?)\)', line)
            if m1:
                hashmode_id = m1.group(1)
                hashmode_name = m1.group(2).strip()
                current_hashmode = f'Hash-Mode {hashmode_id}'
            elif m2:
                hashmode_id = m2.group(1)
                hashmode_name = m2.group(2).strip()
                current_hashmode = f'Hash-Mode {hashmode_id}'
            # Match Speed
            speed_match = re.search(r'Speed\.(?:Dev\.#\d+|#\d+|#\*)\.*:\s*([0-9\.\,]+)\s*([kMGT]?H/s)', line)
            if current_hashmode and speed_match:
                speed_value = speed_match.group(1).replace(',', '')
                speed_unit = speed_match.group(2)
                # Unit H/s
                unit_map = {'H/s': 1, 'kH/s': 1e3, 'MH/s': 1e6, 'GH/s': 1e9, 'TH/s': 1e12}
                speed = float(speed_value) * unit_map.get(speed_unit, 1)
                # Just first device, ignore other devices
                if current_hashmode not in devices[device_name]:
                    devices[device_name][current_hashmode] = {
                        "hashmode_id": hashmode_id,
                        "hashmode_name": hashmode_name,
                        "speed": speed
                    }
    


    # Check parse devices
    print("Detect devices:", len(devices))
    for device, hashmode_data in devices.items():
        hashmode = 'Hash-Mode 0'
        if hashmode in hashmode_data:
            human_readable_speed = humanize.naturalsize(hashmode_data[hashmode]["speed"])
        else:
            human_readable_speed = 0
        # device name default 10 chars
        device_name = device[:10]
        if len(device_name) < 10:
            device_name = device_name + ' ' * (10 - len(device_name))
        print(f"{device_name} \t-> {hashmode}: {human_readable_speed}")

    return devices


def save2json(datas_json_path, datas):
    with open(datas_json_path, 'w', encoding='utf-8') as f:
        json.dump(datas, f, ensure_ascii=False, indent=2)
    print(f"数据已保存到: {datas_json_path}")


def draw_chart(hashmode, devices, showimage=False):
    # Extra device name and Hash-Mode 0 speed
    device_names = []
    speeds = []
    for device, hashmode_data in devices.items():
        if hashmode in hashmode_data:
            device_names.append(device)
            speeds.append(hashmode_data[hashmode]["speed"])

    # best performance in first
    sorted_data = sorted(zip(speeds, device_names), reverse=False)
    sorted_speeds, sorted_device_names = zip(*sorted_data)

    # draw view
    fig_height = max(8, len(sorted_device_names) * 0.6)  # auto height
    plt.figure(figsize=(12, fig_height))
    
    # create bar image
    y_pos = np.arange(len(sorted_device_names))
    bars = plt.barh(y_pos, sorted_speeds, color='skyblue', edgecolor='navy', alpha=0.7)
    
    # add tag
    for i, (bar, speed) in enumerate(zip(bars, sorted_speeds)):
        width = bar.get_width()
        plt.text(width, bar.get_y() + bar.get_height()/2, 
                humanize.naturalsize(speed), 
                ha='left', va='center', fontsize=9, fontweight='bold')
    
    # add value
    plt.yticks(y_pos, sorted_device_names)
    plt.xlabel(f'{hashmode} ({hashmode_data[hashmode]["hashmode_name"]}) Speed (H/s)')
    plt.title(f'Device for {hashmode} ({hashmode_data[hashmode]["hashmode_name"]}) Speed', fontsize=14, fontweight='bold')
    
    # add grid net
    plt.grid(True, axis='x', alpha=0.3)
    
    # ajustive layout
    plt.tight_layout()

    # save image to images hashmode-xxx.png
    # Save the image to the images directory, filename as xxx.png
    if not os.path.exists('images'):
        os.makedirs('images')
    safe_hashmode = re.sub(r'[^a-zA-Z0-9]+', '_', hashmode)
    filename = f'images/{safe_hashmode}.png'
    plt.savefig(filename, dpi=150)
    print(f"Image saved to: {filename}")

    # show image
    if showimage:
        plt.show()


if __name__ == "__main__":
    datas = load_benchmarks('benchmarks')
    save2json("pages/datas.json", datas)
    draw_chart('Hash-Mode 0', datas)
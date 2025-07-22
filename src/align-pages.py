#!/usr/bin/env python3

# align pages between
# - out/{asin}/pages/white/*.png
# - out/{asin}/pages/black/*.png

# detect extra pages
# which have no matching page in the other directory

import os
import re
import sys
import subprocess
from pathlib import Path
from typing import List, Tuple, Dict, Any
import shlex
import copy

import cv2
import numpy as np
# import PIL
import imageio.v3 as iio
import skimage.metrics
import skimage.util
import dotenv

SIMILARITY_THRESHOLD = 0.9

MAX_LAST_MATCH_DISTANCE = 5

# FIXME small images (smilies, latex formulas, ...) should be detected too
# example: letter "/" has 8x19 pixels
CROP_MIN_WIDTH, CROP_MIN_HEIGHT = 30, 30
# CROP_MIN_WIDTH, CROP_MIN_HEIGHT = 0, 0 # debug

CROP_BORDER_X, CROP_BORDER_Y = 0, 0
# CROP_BORDER_X, CROP_BORDER_Y = 2, 2 # debug

# actual mismatch pages have between 30 and 500 small rectangles
# (in my case)
MAX_NUM_SMALL_RECTANGLES = 10

def get_similarity(img1: np.ndarray, img2: np.ndarray) -> float:
    """Calculate structural similarity between two images (0-1 scale)"""
    # Resize images if they have different dimensions
    if img1.shape != img2.shape:
        img2 = cv2.resize(img2, (img1.shape[1], img1.shape[0]))

    # Convert to grayscale if they're color images
    if len(img1.shape) == 3:
        img1 = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY)
    if len(img2.shape) == 3:
        img2 = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY)

    # Calculate Structural Similarity Index (SSIM)
    score = skimage.metrics.structural_similarity(img1, img2)
    return score

def image_invert_colors(image: np.ndarray) -> np.ndarray:
    """Invert colors of an image (RGB) and return the inverted image"""
    # https://stackoverflow.com/a/11491499/10440128
    inverted = copy.deepcopy(image)
    inverted[:,:,0:3] = 255 - inverted[:,:,0:3]
    return inverted

def page_of_path(p: str) -> int:
    """Extract page number from filename"""
    return int(Path(p).name.split("-")[0])

def find_white_rectangles(image_path: str) -> List[Dict[str, int]]:
    """Find white rectangles in an image"""
    img = cv2.imread(image_path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresholded = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(
        thresholded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    rectangles = []
    for contour in contours:
        epsilon = 0.02 * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, epsilon, True)
        if len(approx) == 4:
            x, y, w, h = cv2.boundingRect(approx)
            rectangles.append((x, y, w, h))
    return rectangles

def image_remove_alpha_channel(image):
    # https://stackoverflow.com/a/35902359/10440128
    return image[:,:,:3]

async def main():

    dotenv.load_dotenv()

    asin = os.getenv("ASIN")
    if not asin:
        raise ValueError("ASIN environment variable not set")

    white_dir = Path(f"out/{asin}/pages/white")
    black_dir = Path(f"out/{asin}/pages/black")

    white_files = sorted([f for f in os.listdir(white_dir) if not (
        f.endswith('.inv.png') or
        f.endswith('.mon.png') or
        f.endswith('.diff.png') or
        f.endswith('.crop.png') or
        f.endswith('.leveled.png')
    )])
    black_files = sorted(os.listdir(black_dir))

    matches = list()
    consumed_black_files = set()
    last_match_white_idx = -1
    last_match_white_page = -1
    search_radius = 0

    # TODO update search_offset
    search_offset = 0

    white_idx = -1
    last_white_idx = len(white_files) - 1

    # for white_idx, white_file in enumerate(white_files):
    while white_idx < last_white_idx:

        white_idx += 1

        white_file = white_files[white_idx]
        white_path = white_dir / white_file
        white_page = page_of_path(white_path)

        # Debug: only process one page
        debug_page = None
        debug_page = 61
        if debug_page:
            if white_page < debug_page: continue
            # if white_page > debug_page: break

        print(f"white_idx {white_idx} white_path {white_path}")

        # Read and invert the white image
        white_image = iio.imread(white_path)
        white_image = image_remove_alpha_channel(white_image)
        white_image_inverted = image_invert_colors(white_image)

        # # Save inverted image for debugging
        # inv_path = white_path.with_suffix('.inv.png')
        # print(f"writing {inv_path}")
        # iio.imwrite(inv_path, white_image_inverted)

        print(f"search_offset {search_offset} search_radius {search_radius}")

        found_match = False # TODO remove?

        search_radius_step_range = range(-1 * search_radius, search_radius + 1)

        for search_radius_step in search_radius_step_range:

            black_idx = white_idx + search_offset + search_radius_step

            if black_idx in consumed_black_files:
                # black file was consumed
                print(f"search_radius_step {search_radius_step} - black file was consumed")
                continue

            if search_radius > 0:
                print(f"search_radius_step {search_radius_step}")

            # Get corresponding black file
            black_path = black_dir / black_files[black_idx]

            print(f"black_idx {black_idx} black_path {black_path}")

            # Read black image
            black_image = iio.imread(black_path)
            black_image = image_remove_alpha_channel(black_image)

            # FIXME "black page" images are grey text on black page
            # but should be white text on black page
            # but images have the same lightness
            # so changing color levels could break image detection
            # gimp: colors -> levels -> high: 170/255 = 0.6666666666666666
            # https://stackoverflow.com/a/56909036/10440128
            # GIMP color levels: low=0 high=170/255
            alpha = 255.0 / 170 # Scale factor
            beta = 0 # Offset
            black_leveled_image = cv2.convertScaleAbs(black_image, alpha=alpha, beta=beta)
            # black_leveled_path = black_path.with_suffix('.leveled.png')
            # print(f"writing {black_leveled_path}")
            # iio.imwrite(black_leveled_path, black_leveled_image)

            # TODO handle keywords (grey highlighted words)
            # white pages have a different grey than black pages

            # TODO handle links (underlined blue text)
            # white pages have a different blue than black pages
            # white pages blue text: #0000ff underline: #0000ff
            # black pages blue text: #8fc0e9 underline: #8787ff
            # challenge: handle all shades of a color (gradient)

            # Calculate similarity
            similarity = get_similarity(white_image_inverted, black_image)
            is_similar = similarity >= SIMILARITY_THRESHOLD

            if is_similar:
                print(f"found match (similarity: {similarity:.2f}): {white_path} {black_path}")
                # Mark black file as "consumed"
                consumed_black_files.add(black_idx)
                last_match_white_idx = white_idx
                last_match_white_page = white_page
                found_match = True
                # TODO detect missing images, either in white or black images
                # if search_radius_step < 0: detected missing black images
                # if search_radius_step > 0: detected missing white images
                # ... or inverse?
                if search_radius_step != 0:
                    print(f"updating search_offset from {search_offset} to {search_offset + search_radius_step}")
                    search_offset += search_radius_step
                    print("resetting search_radius to 0")
                    search_radius = 0
                break

            print(f"no match (similarity: {similarity:.2f}): {white_path} {black_path} - detecting images")

            # Save inverted image for debugging
            inv_path = white_path.with_suffix('.inv.png')
            print(f"writing {inv_path}")
            iio.imwrite(inv_path, white_image_inverted)

            black_leveled_path = black_path.with_suffix('.leveled.png')
            print(f"writing {black_leveled_path}")
            iio.imwrite(black_leveled_path, black_leveled_image)

            if 0:
                # Create montage
                # TODO use numpy
                mon_path = white_path.with_suffix('.mon.png')
                args = [
                    'magick',
                    'montage',
                    str(inv_path),
                    str(black_path),
                    '-geometry', '+0+0',
                    str(mon_path),
                ]
                print(f"writing {mon_path}")
                # print('>', shlex.join(args))
                subprocess.run(args, check=True)

            # Create diff image
            diff_path = white_path.with_suffix('.diff.png')
            if 1:
                # use imagemagick
                args = [
                    'magick',
                    'compare',
                    str(white_path),
                    str(black_path),
                    '-compose', 'src',
                    '-highlight-color', 'black',
                    '-lowlight-color', 'white',
                    str(diff_path),
                ]
                print(f"writing {diff_path}")
                # print('>', shlex.join(args))
                # no. "magick compare" returns 1 when images differ
                # subprocess.run(args, check=True)
                subprocess.run(args)
            else:
                # use numpy
                # FIXME this is ugly
                diff_image = white_image - black_image
                print(f"writing {diff_path}")
                iio.imwrite(diff_path, diff_image)

            # Find white rectangles in diff image
            rectangles = find_white_rectangles(str(diff_path))
            # print({"rectangles": rectangles})

            num_small_rectangles = 0
            for rectangle in rectangles:
                x, y, w, h = rectangle
                # require minimum size
                if w < CROP_MIN_WIDTH or h < CROP_MIN_HEIGHT:
                    # print(f'rectangle {x}x{y}+{w}+{h} - too small') # debug
                    num_small_rectangles += 1
                    continue
                if (CROP_BORDER_X, CROP_BORDER_Y) != (0, 0):
                    # add border
                    x -= CROP_BORDER_X
                    y -= CROP_BORDER_Y
                    w += CROP_BORDER_X * 2
                    h += CROP_BORDER_Y * 2
                # print(f'rectangle {x}x{y}+{w}+{h}')
                crop_image = white_image[y:y+h,x:x+w]
                # TODO handle all-white images (text layout spacers)
                crop_path = white_path.with_suffix(f'.{x}x{y}+{w}+{h}.crop.png')
                print(f"writing {crop_path}")
                iio.imwrite(crop_path, crop_image)

            if num_small_rectangles <= MAX_NUM_SMALL_RECTANGLES:
                print(f"num_small_rectangles {num_small_rectangles} -> actual match")
                last_match_white_idx = white_idx
                last_match_white_page = white_page
                found_match = True
                search_offset += search_radius_step
                break

            print(f"num_small_rectangles {num_small_rectangles} -> actual mismatch")

            last_match_distance = white_idx - last_match_white_idx
            if last_match_distance > MAX_LAST_MATCH_DISTANCE:
                # seek back and expand the search radius
                # to handle missing pages in either black or white pages
                print(
                    f"last_match_distance {last_match_distance} -> "
                    f"seeking back to white_idx {last_match_white_idx + 1} "
                    f"(page {last_match_white_page}) "
                    f"and expanding the search radius to {search_radius + 1}"
                )
                white_idx = last_match_white_idx
                search_radius += 1
                found_match = False
                break

            found_match = False
            continue

        if found_match:
            print(f"found match: white_idx {white_idx} black_idx {black_idx}")
            matches.append((white_idx, black_idx))
            print("last 10 matches:")
            lwi = -1; lbi = -1 # last indices
            for match in matches[-10:]:
                wi, bi = match
                if lwi != -1 and lwi + 1 < wi:
                    for i in range(lwi + 1, wi):
                        p = white_dir / white_files[i]
                        print(f"  extra white page: {i} {p}")
                if lbi != -1 and lbi + 1 < bi:
                    for i in range(lbi + 1, bi):
                        p = black_dir / black_files[i]
                        print(f"  extra black page: {i} {p}")
                wp = white_dir / white_files[wi]
                bp = black_dir / black_files[bi]
                print(f"  match {wi} {bi} {wp} {bp}")
                # print(f"  white_idx {wi} black_idx {bi}")
                # print(f"    {wp} {bp}")
                lwi = wi; lbi = bi

        print()
        continue

    print('done. to remove tempfiles:')
    print(f"  rm out/{asin}/pages/*/*.{{inv,mon,diff,crop}}.png")

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())

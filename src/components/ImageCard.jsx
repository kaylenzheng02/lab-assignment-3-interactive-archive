import { Link } from "react-router";
import "./ImageCard.css";

function ImageCard({ image }) {
  return (
    <div className="card">
      <Link to={`/image/${image.id}`}>
        <img src={image.src} alt={image.title} />
      </Link>
      <p>{image.title}</p>
    </div>
  );
}

export default ImageCard;
